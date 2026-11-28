import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, configPath, loadConfig, presetProvider, saveConfig, type ModelPreset } from "../src/index.js";

let dir: string;
let file: string;
/** An env that points only at the temp config file, so the real one is never read. */
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clipy-local-config-"));
  file = join(dir, "nested", "config.json");
  env = { CLIPY_LOCAL_CONFIG: file };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(value: unknown) {
  saveConfig({}, env); // creates the directory
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

describe("configPath", () => {
  it("uses XDG_CONFIG_HOME on Linux, else ~/.config", () => {
    expect(configPath({ HOME: "/home/ana", XDG_CONFIG_HOME: "/xdg" }, "linux")).toBe("/xdg/clipy-local/config.json");
    expect(configPath({ HOME: "/home/ana" }, "linux")).toBe("/home/ana/.config/clipy-local/config.json");
    // The XDG spec says to ignore a relative value.
    expect(configPath({ HOME: "/home/ana", XDG_CONFIG_HOME: "rel" }, "linux")).toBe("/home/ana/.config/clipy-local/config.json");
  });

  it("uses Application Support on macOS", () => {
    expect(configPath({ HOME: "/Users/ana", XDG_CONFIG_HOME: "/xdg" }, "darwin")).toBe(
      "/Users/ana/Library/Application Support/clipy-local/config.json",
    );
  });

  it("uses %APPDATA% on Windows", () => {
    expect(configPath({ APPDATA: "C:\\Users\\ana\\AppData\\Roaming" }, "win32")).toBe(
      "C:\\Users\\ana\\AppData\\Roaming\\clipy-local\\config.json",
    );
    expect(configPath({ USERPROFILE: "C:\\Users\\ana" }, "win32")).toBe(
      "C:\\Users\\ana\\AppData\\Roaming\\clipy-local\\config.json",
    );
  });

  it("lets CLIPY_LOCAL_CONFIG override every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(configPath({ HOME: "/h", APPDATA: "C:\\a", CLIPY_LOCAL_CONFIG: "/tmp/c.json" }, platform)).toBe("/tmp/c.json");
    }
  });
});

describe("loadConfig defaults", () => {
  it("gives rules only and local English transcription when there is no file", () => {
    expect(loadConfig(env)).toEqual({
      model: null,
      modelPreset: null,
      transcription: { kind: "local", model: "english-fast" },
      telemetry: false,
    });
  });

  it("keeps telemetry off whatever the file says", () => {
    writeConfig({ telemetry: true });
    expect(loadConfig(env).telemetry).toBe(false);
  });
});

describe("presets", () => {
  const cases: Array<[ModelPreset, string, string]> = [
    ["openrouter", "https://openrouter.ai/api/v1", "google/gemini-3.1-flash-lite"],
    ["openai", "https://api.openai.com/v1", "gpt-4.1-mini"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash"],
    ["groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
  ];
  it.each(cases)("%s has its base URL and default model", (preset, baseUrl, model) => {
    expect(presetProvider(preset, "k")).toMatchObject({ baseUrl, model, apiKey: "k" });
    expect(presetProvider(preset, "k", "other/model").model).toBe("other/model");
  });

  it("sends OpenRouter's attribution headers", () => {
    expect(presetProvider("openrouter", "k").headers).toEqual({ "HTTP-Referer": "https://clipy.online", "X-Title": "Clipy" });
    expect(presetProvider("openai", "k").headers).toBeUndefined();
  });

  it("runs Ollama and LM Studio locally with no key, but needs a model", () => {
    expect(presetProvider("ollama", undefined, "llama3.2")).toEqual({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" });
    expect(presetProvider("lmstudio", undefined, "qwen")).toEqual({ baseUrl: "http://127.0.0.1:1234/v1", model: "qwen" });
    expect(errorOf(() => presetProvider("ollama")).message).toMatch(/Ollama needs a model name.*CLIPY_MODEL/);
    expect(errorOf(() => presetProvider("lmstudio")).message).toMatch(/LM Studio needs a model name/);
  });

  it("needs a key for hosted providers and a URL for custom", () => {
    expect(errorOf(() => presetProvider("openai")).message).toMatch(/OpenAI needs an API key.*CLIPY_MODEL_API_KEY/);
    expect(errorOf(() => presetProvider("custom", undefined, "m")).message).toMatch(/needs a base URL/);
    expect(presetProvider("custom", undefined, "m", "http://box:8080/v1")).toEqual({ baseUrl: "http://box:8080/v1", model: "m" });
  });

  it("reports a missing Ollama model from the file with the file's path", () => {
    writeConfig({ model: { preset: "ollama" } });
    const error = errorOf(() => loadConfig(env));
    expect(error.message).toMatch(/Ollama needs a model name/);
    expect(error.message).toContain(file);
  });
});

describe("env vars override the file", () => {
  beforeEach(() => {
    saveConfig(
      {
        model: { preset: "openai", apiKey: "sk-file", model: "gpt-file" },
        transcription: { kind: "deepgram", apiKey: "dg-file" },
      },
      env,
    );
  });

  it("uses the file when no env var is set", () => {
    const config = loadConfig(env);
    expect(config.modelPreset).toBe("openai");
    expect(config.model).toEqual({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-file", model: "gpt-file" });
    expect(config.transcription).toEqual({ kind: "deepgram", apiKey: "dg-file" });
  });

  it("overrides single fields for the same provider", () => {
    const config = loadConfig({ ...env, CLIPY_MODEL: "gpt-env", CLIPY_MODEL_API_KEY: "sk-env", CLIPY_TRANSCRIBE_MODEL: "nova-3" });
    expect(config.model).toMatchObject({ apiKey: "sk-env", model: "gpt-env" });
    expect(config.transcription).toEqual({ kind: "deepgram", apiKey: "dg-file", model: "nova-3" });
  });

  it("ignores empty env vars", () => {
    expect(loadConfig({ ...env, CLIPY_MODEL: "", CLIPY_MODEL_PROVIDER: "  " }).model?.model).toBe("gpt-file");
  });

  it("never sends the saved key to another provider", () => {
    expect(errorOf(() => loadConfig({ ...env, CLIPY_MODEL_PROVIDER: "groq" })).message).toMatch(/Groq needs an API key/);
    const groq = loadConfig({ ...env, CLIPY_MODEL_PROVIDER: "groq", CLIPY_MODEL_API_KEY: "gsk-env" });
    expect(groq.modelPreset).toBe("groq");
    expect(groq.model).toEqual({ baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk-env", model: "llama-3.3-70b-versatile" });
  });

  it("never sends the saved key to another base URL", () => {
    const moved = { ...env, CLIPY_MODEL_BASE_URL: "http://elsewhere:9000/v1" };
    expect(errorOf(() => loadConfig(moved)).message).toMatch(/OpenAI needs an API key/);
    expect(loadConfig({ ...moved, CLIPY_MODEL_API_KEY: "sk-env" }).model).toEqual({
      baseUrl: "http://elsewhere:9000/v1",
      apiKey: "sk-env",
      model: "gpt-file",
    });
    // The same URL as the preset keeps the saved key.
    expect(loadConfig({ ...env, CLIPY_MODEL_BASE_URL: "https://api.openai.com/v1/" }).model?.apiKey).toBe("sk-file");
  });

  it("switches to a local provider with no key", () => {
    const config = loadConfig({ ...env, CLIPY_MODEL_PROVIDER: "ollama", CLIPY_MODEL: "llama3.2" });
    expect(config.model).toEqual({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.2" });
  });

  it("switches transcription and drops the saved key", () => {
    expect(errorOf(() => loadConfig({ ...env, CLIPY_TRANSCRIBE: "assemblyai" })).message).toMatch(
      /assemblyai needs an API key.*CLIPY_TRANSCRIBE_API_KEY/,
    );
    expect(loadConfig({ ...env, CLIPY_TRANSCRIBE: "local" }).transcription).toEqual({ kind: "local", model: "english-fast" });
    expect(loadConfig({ ...env, CLIPY_TRANSCRIBE: "none" }).transcription).toEqual({ kind: "none" });
  });

  it("rejects unknown names in env vars", () => {
    expect(errorOf(() => loadConfig({ ...env, CLIPY_MODEL_PROVIDER: "anthropic" })).message).toMatch(
      /CLIPY_MODEL_PROVIDER must be one of openrouter, openai/,
    );
    expect(errorOf(() => loadConfig({ ...env, CLIPY_TRANSCRIBE: "whisper" })).message).toMatch(/CLIPY_TRANSCRIBE must be one of/);
  });

  it("defaults to OpenRouter when only a key is given", () => {
    const config = loadConfig({ CLIPY_LOCAL_CONFIG: join(dir, "absent.json"), CLIPY_MODEL_API_KEY: "sk-or" });
    expect(config.modelPreset).toBe("openrouter");
    expect(config.model?.model).toBe("google/gemini-3.1-flash-lite");
  });
});

describe("transcription presets", () => {
  it("maps OpenAI and Groq to their OpenAI-compatible endpoints", () => {
    const empty = { CLIPY_LOCAL_CONFIG: join(dir, "absent.json") };
    expect(loadConfig({ ...empty, CLIPY_TRANSCRIBE: "openai", CLIPY_TRANSCRIBE_API_KEY: "sk" }).transcription).toEqual({
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk",
      model: "whisper-1",
    });
    expect(loadConfig({ ...empty, CLIPY_TRANSCRIBE: "groq", CLIPY_TRANSCRIBE_API_KEY: "gsk" }).transcription).toEqual({
      kind: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "gsk",
      model: "whisper-large-v3-turbo",
    });
  });

  it("takes a custom OpenAI-compatible server, which may need no key", () => {
    saveConfig({ transcription: { kind: "openai-compatible", baseUrl: "http://127.0.0.1:8000/v1", model: "large-v3" } }, env);
    expect(loadConfig(env).transcription).toEqual({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "",
      model: "large-v3",
    });
  });

  it("drops the saved transcription key when the base URL moves", () => {
    saveConfig({ transcription: { kind: "openai", apiKey: "sk-file" } }, env);
    expect(loadConfig({ ...env, CLIPY_TRANSCRIBE_BASE_URL: "https://api.openai.com/v1" }).transcription).toMatchObject({
      apiKey: "sk-file",
      model: "whisper-1",
    });
    expect(loadConfig({ ...env, CLIPY_TRANSCRIBE_BASE_URL: "http://127.0.0.1:8000/v1", CLIPY_TRANSCRIBE_MODEL: "large-v3" }).transcription).toEqual({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "",
      model: "large-v3",
    });
  });

  it("picks the multilingual local model", () => {
    saveConfig({ transcription: { kind: "local", model: "multilingual" } }, env);
    expect(loadConfig(env).transcription).toEqual({ kind: "local", model: "multilingual" });
    expect(errorOf(() => loadConfig({ ...env, CLIPY_TRANSCRIBE_MODEL: "huge" })).message).toMatch(/english-fast, multilingual/);
  });
});

describe("saveConfig", () => {
  it.skipIf(process.platform === "win32")("writes the file with mode 0600", () => {
    saveConfig({ model: { preset: "openrouter", apiKey: "sk-or" } }, env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    saveConfig({ transcription: { kind: "none" } }, env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces only the fields it is given and keeps unknown keys", () => {
    writeConfig({ model: { preset: "openrouter", apiKey: "sk-or" }, futureSetting: { a: 1 } });
    saveConfig({ transcription: { kind: "none" } }, env);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      model: { preset: "openrouter", apiKey: "sk-or" },
      transcription: { kind: "none" },
      futureSetting: { a: 1 },
    });
    saveConfig({ model: null }, env);
    expect(loadConfig(env).model).toBeNull();
  });

  it("refuses an invalid patch without touching the file", () => {
    saveConfig({ model: { preset: "openrouter", apiKey: "sk-or" } }, env);
    const before = readFileSync(file, "utf8");
    const error = errorOf(() => saveConfig({ model: { preset: "nope" as ModelPreset } }, env));
    expect(error.message).toMatch(/"model.preset"/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});
describe("UTF-8 BOM", () => {
  it("loads a config file with a UTF-8 BOM", () => {
    writeConfig('\uFEFF{"model":{"preset":"openrouter","apiKey":"sk-test"}}');

    const config = loadConfig(env);

    expect(config.model).toMatchObject({
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it("updates a BOM-prefixed file and saves it without a BOM", () => {
    writeConfig('\uFEFF{"futureSetting":{"enabled":true}}');

    saveConfig({ transcription: { kind: "none" } }, env);

    const savedText = readFileSync(file, "utf8");

    expect(savedText.startsWith("\uFEFF")).toBe(false);
    expect(JSON.parse(savedText)).toEqual({
      version: 1,
      transcription: { kind: "none" },
      futureSetting: { enabled: true },
    });
  });
});

describe("a malformed file", () => {
  it("names the file and position for bad JSON, without quoting it", () => {
    writeConfig('{\n  "model": { "preset": "openai", "apiKey": "sk-secret-123" ,, }\n}');
    const error = errorOf(() => loadConfig(env));
    expect(error.message).toContain(file);
    expect(error.message).toMatch(/not valid JSON at line 2, column \d+/);
    expect(error.message).not.toContain("sk-secret-123");
    expect(error.stack ?? "").not.toContain("sk-secret-123");
  });

  it("names the bad field", () => {
    writeConfig({ model: { preset: "anthropic", apiKey: "sk-secret-123" } });
    const error = errorOf(() => loadConfig(env));
    expect(error.message).toContain(file);
    expect(error.message).toMatch(/"model.preset"/);
    expect(error.message).not.toContain("sk-secret-123");
  });

  it("names a typo inside a section", () => {
    writeConfig({ model: { preset: "openai", apikey: "sk-secret-123" } });
    expect(errorOf(() => loadConfig(env)).message).toMatch(/"model".*apikey/);
  });

  it("names a bad transcription kind", () => {
    writeConfig({ transcription: { kind: "whisper" } });
    expect(errorOf(() => loadConfig(env)).message).toMatch(/"transcription.kind": must be one of none, local/);
  });

  it("says the file must hold an object", () => {
    writeConfig("[1, 2]");
    expect(errorOf(() => loadConfig(env)).message).toMatch(/must contain a JSON object/);
  });

  it("is not overwritten by saveConfig", () => {
    writeConfig("{ broken");
    expect(errorOf(() => saveConfig({ transcription: { kind: "none" } }, env)).message).toMatch(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ broken");
  });
});
