/**
 * @clipy/local-config: the local edition's settings. Which model provider (if
 * any) reads the transcript for spoken cues, and how recordings are
 * transcribed.
 *
 * Settings come from a JSON file (see `configPath` and `StoredConfig`), and
 * env vars override the file:
 *
 * | Env var | Overrides |
 * |---|---|
 * | `CLIPY_MODEL_PROVIDER` | `model.preset` (openrouter, openai, gemini, groq, ollama, lmstudio, custom) |
 * | `CLIPY_MODEL_BASE_URL` | `model.baseUrl` |
 * | `CLIPY_MODEL_API_KEY` | `model.apiKey` |
 * | `CLIPY_MODEL` | `model.model` |
 * | `CLIPY_TRANSCRIBE` | `transcription.kind` |
 * | `CLIPY_TRANSCRIBE_API_KEY` | `transcription.apiKey` |
 * | `CLIPY_TRANSCRIBE_MODEL` | `transcription.model` |
 * | `CLIPY_TRANSCRIBE_BASE_URL` | `transcription.baseUrl` (OpenAI-compatible only) |
 * | `CLIPY_LOCAL_CONFIG` | the file's path |
 *
 * A key saved in the file is only ever sent to the endpoint it was saved for.
 * When an env var switches to another provider, the saved key and model are
 * dropped; when it only moves the base URL, the saved key is dropped and the
 * model name is kept.
 *
 * Nothing here prints or logs, and error messages never contain a key.
 * Telemetry is always off in this edition.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PROVIDER_BASE_URLS, type ModelProvider } from "@clipy/moments";
import { ConfigError } from "./errors.js";
import { configPath, envValue } from "./paths.js";
import { DEFAULT_MODELS, presetProvider, TRANSCRIPTION_PRESETS } from "./presets.js";
import {
  describeIssues,
  KEYED_TRANSCRIPTION_KINDS,
  LOCAL_TRANSCRIPTION_MODELS,
  MODEL_PRESETS,
  storedConfigSchema,
  TRANSCRIPTION_KINDS,
  type LocalTranscriptionModel,
  type ModelPreset,
  type StoredConfig,
  type StoredModel,
  type StoredTranscription,
  type StoredTranscriptionKind,
} from "./schema.js";

export { ConfigError } from "./errors.js";
export { configPath } from "./paths.js";
export { DEFAULT_MODELS, presetProvider, TRANSCRIPTION_PRESETS } from "./presets.js";
export {
  LOCAL_TRANSCRIPTION_MODELS,
  MODEL_PRESETS,
  TRANSCRIPTION_KINDS,
  type LocalTranscriptionModel,
  type ModelPreset,
  type StoredConfig,
  type StoredModel,
  type StoredTranscription,
  type StoredTranscriptionKind,
} from "./schema.js";
export type { ModelProvider } from "@clipy/moments";

/** How recordings are transcribed, resolved and ready to use. */
export type TranscriptionConfig =
  | { kind: "none" }
  | { kind: "local"; model: LocalTranscriptionModel }
  /** OpenAI, Groq or another OpenAI-compatible `/audio/transcriptions` endpoint. apiKey is "" when the server needs none. */
  | { kind: "openai-compatible"; baseUrl: string; apiKey: string; model: string }
  | { kind: (typeof KEYED_TRANSCRIPTION_KINDS)[number]; apiKey: string; model?: string };

export interface LocalConfig {
  /** null: rules only, nothing leaves the machine. */
  model: ModelProvider | null;
  modelPreset: ModelPreset | null;
  transcription: TranscriptionConfig;
  /** Always false in the local edition. */
  telemetry: false;
}

/** A source label for a setting, with only the name of any environment override. */
export type ConfigSource = "file" | "default" | `env:CLIPY_${string}`;

export interface ConfigExplanation {
  /** Each field holds its source, or null when it has no value for the selected provider. */
  model: {
    preset: ConfigSource;
    baseUrl: ConfigSource | null;
    model: ConfigSource | null;
    apiKey: ConfigSource | null;
  };
  transcription: {
    kind: ConfigSource;
    baseUrl: ConfigSource | null;
    model: ConfigSource | null;
    apiKey: ConfigSource | null;
  };
  notes: string[];
}

/** The default when nothing is configured: the local "English, fast" model, on every platform. */
export const DEFAULT_TRANSCRIPTION: StoredTranscription = { kind: "local", model: "english-fast" };

type StoredFile = StoredConfig & Record<string, unknown>;

/** Character offset to "line L, column C", for a JSON error that must not quote the file. */
function lineAndColumn(text: string, offset: number): string {
  const before = text.slice(0, offset).split("\n");
  return `line ${before.length}, column ${before[before.length - 1].length + 1}`;
}

/** The file as saved, validated. A missing file is an empty config. */
function readStored(path: string): StoredFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new ConfigError(`Cannot read the config file ${path} (${code ?? "unknown error"}).`);
  }
  if (!text.trim()) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // V8's message can quote part of the file, which may hold a key. Keep only the position.
    const position = /position (\d+)/.exec(String((error as Error).message))?.[1];
    const where = position ? ` at ${lineAndColumn(text, Number(position))}` : "";
    throw new ConfigError(`The config file ${path} is not valid JSON${where}.`);
  }
  const parsed = storedConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`The config file ${path} has an invalid setting: ${describeIssues(parsed.error)}.`);
  }
  return parsed.data as StoredFile;
}

function sameUrl(a: string | undefined, b: string | undefined): boolean {
  const norm = (u: string | undefined) => u?.trim().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function oneOf<T extends string>(values: readonly T[], value: string, envName: string): T {
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(`${envName} must be one of ${values.join(", ")}.`);
}

function withPath(error: unknown, path: string): never {
  if (error instanceof ConfigError) throw new ConfigError(`${error.message} (config file: ${path})`);
  throw error;
}

function fieldSource(envName: `CLIPY_${string}`, override?: string, saved?: string, hasDefault = false): ConfigSource | null {
  if (override) return `env:${envName}`;
  if (saved) return "file";
  return hasDefault ? "default" : null;
}

function mergeModel(stored: StoredModel | null | undefined, env: NodeJS.ProcessEnv) {
  const envPreset = envValue(env, "CLIPY_MODEL_PROVIDER");
  const envBase = envValue(env, "CLIPY_MODEL_BASE_URL");
  const envKey = envValue(env, "CLIPY_MODEL_API_KEY");
  const envModel = envValue(env, "CLIPY_MODEL");

  const notes: string[] = [];
  let presetSource: ConfigSource = stored === undefined ? "default" : "file";
  let draft: Partial<StoredModel> = stored ? { ...stored } : {};
  if (envPreset) {
    const preset = oneOf(MODEL_PRESETS, envPreset, "CLIPY_MODEL_PROVIDER");
    if (preset !== draft.preset) {
      if (draft.apiKey) notes.push("saved model key not used: CLIPY_MODEL_PROVIDER switched provider");
      if (draft.model) notes.push("saved model name not used: CLIPY_MODEL_PROVIDER switched provider");
      draft = { preset };
    }
    presetSource = "env:CLIPY_MODEL_PROVIDER";
  }
  if (envBase) {
    // A different endpoint never inherits the saved key. The model name is kept.
    const savedBase = draft.baseUrl ?? (draft.preset && draft.preset !== "custom" ? PROVIDER_BASE_URLS[draft.preset] : undefined);
    if (!sameUrl(envBase, savedBase)) {
      if (draft.apiKey) notes.push("saved model key not used: CLIPY_MODEL_BASE_URL changed the endpoint");
      if (!draft.preset) presetSource = "env:CLIPY_MODEL_BASE_URL";
      draft = { preset: draft.preset ?? "custom", model: draft.model };
    }
    draft.baseUrl = envBase;
  }
  // A key or model name alone picks the default provider, OpenRouter.
  if (!draft.preset && (envKey || envModel)) {
    draft = { preset: "openrouter" };
    presetSource = "default";
  }
  if (envKey) draft.apiKey = envKey;
  if (envModel) draft.model = envModel;

  const hasDefaultBase = draft.preset !== undefined && draft.preset !== "custom";
  const hasDefaultModel = Boolean(draft.preset && DEFAULT_MODELS[draft.preset]);
  const sources: ConfigExplanation["model"] = {
    preset: presetSource,
    baseUrl: fieldSource("CLIPY_MODEL_BASE_URL", envBase, draft.baseUrl, hasDefaultBase),
    model: fieldSource("CLIPY_MODEL", envModel, draft.model, hasDefaultModel),
    apiKey: fieldSource("CLIPY_MODEL_API_KEY", envKey, draft.apiKey),
  };
  return { draft, sources, notes };
}

function resolveModel(stored: StoredModel | null | undefined, env: NodeJS.ProcessEnv, path: string) {
  const { draft } = mergeModel(stored, env);
  if (!draft.preset) return { model: null, modelPreset: null };
  try {
    return { model: presetProvider(draft.preset, draft.apiKey, draft.model, draft.baseUrl), modelPreset: draft.preset };
  } catch (error) {
    return withPath(error, path);
  }
}

/** Where an OpenAI-compatible transcription draft would send audio, if anywhere. */
function transcriptionBase(draft: { kind?: StoredTranscriptionKind; baseUrl?: string }): string | undefined {
  if (draft.kind === "openai" || draft.kind === "groq") return TRANSCRIPTION_PRESETS[draft.kind].baseUrl;
  if (draft.kind === "openai-compatible") return draft.baseUrl;
  return undefined;
}

function mergeTranscription(stored: StoredTranscription | undefined, env: NodeJS.ProcessEnv) {
  const envKind = envValue(env, "CLIPY_TRANSCRIBE");
  const envKey = envValue(env, "CLIPY_TRANSCRIBE_API_KEY");
  const envModel = envValue(env, "CLIPY_TRANSCRIBE_MODEL");
  const envBase = envValue(env, "CLIPY_TRANSCRIBE_BASE_URL");

  const notes: string[] = [];
  let kindSource: ConfigSource = stored ? "file" : "default";
  let modelSource: ConfigSource = stored && "model" in stored && stored.model ? "file" : "default";
  type Draft = { kind: StoredTranscriptionKind; apiKey?: string; model?: string; baseUrl?: string };
  let draft: Draft = { ...(stored ?? DEFAULT_TRANSCRIPTION) };
  if (envKind) {
    const kind = oneOf(TRANSCRIPTION_KINDS, envKind, "CLIPY_TRANSCRIBE");
    if (kind !== draft.kind) {
      if (draft.apiKey) notes.push("saved transcription key not used: CLIPY_TRANSCRIBE switched provider");
      if (modelSource === "file") notes.push("saved transcription model not used: CLIPY_TRANSCRIBE switched provider");
      draft = { kind };
      modelSource = "default";
    }
    kindSource = "env:CLIPY_TRANSCRIBE";
  }
  if (envBase) {
    if (envKind && !["openai", "groq", "openai-compatible"].includes(envKind)) {
      throw new ConfigError(`CLIPY_TRANSCRIBE_BASE_URL only applies to OpenAI-compatible transcription, not ${envKind}.`);
    }
    // A different endpoint never inherits the saved key. The model name is kept.
    const sameEndpoint = sameUrl(envBase, transcriptionBase(draft));
    if (!sameEndpoint) {
      if (draft.apiKey) notes.push("saved transcription key not used: CLIPY_TRANSCRIBE_BASE_URL changed the endpoint");
      // A new endpoint replaces a preset selection. An already custom kind stays custom.
      if (draft.kind !== "openai-compatible") kindSource = "env:CLIPY_TRANSCRIBE_BASE_URL";
    }
    const model = draft.model ?? defaultTranscriptionModel(draft.kind);
    draft = sameEndpoint
      ? { kind: "openai-compatible", baseUrl: envBase, apiKey: draft.apiKey, model }
      : { kind: "openai-compatible", baseUrl: envBase, model: draft.model };
  }
  if (envKey) draft.apiKey = envKey;
  if (envModel) {
    draft.model = envModel;
    modelSource = "env:CLIPY_TRANSCRIBE_MODEL";
  }

  const usesKey = draft.kind !== "none" && draft.kind !== "local";
  const usesModel = draft.kind !== "none" && (draft.model || draft.kind === "local" || defaultTranscriptionModel(draft.kind));
  const sources: ConfigExplanation["transcription"] = {
    kind: kindSource,
    baseUrl: fieldSource("CLIPY_TRANSCRIBE_BASE_URL", envBase, draft.baseUrl, Boolean(transcriptionBase(draft))),
    model: usesModel ? modelSource : null,
    apiKey: usesKey ? fieldSource("CLIPY_TRANSCRIBE_API_KEY", envKey, draft.apiKey) : null,
  };
  return { draft, sources, notes };
}

function resolveTranscription(stored: StoredTranscription | undefined, env: NodeJS.ProcessEnv, path: string): TranscriptionConfig {
  const { draft } = mergeTranscription(stored, env);
  const needKey = (who: string) =>
    new ConfigError(
      `Transcription with ${who} needs an API key. Set CLIPY_TRANSCRIBE_API_KEY or "transcription.apiKey" (config file: ${path}).`,
    );

  switch (draft.kind) {
    case "none":
      return { kind: "none" };
    case "local": {
      const model = draft.model ?? "english-fast";
      if (!(LOCAL_TRANSCRIPTION_MODELS as readonly string[]).includes(model)) {
        throw new ConfigError(
          `The local transcription model must be one of ${LOCAL_TRANSCRIPTION_MODELS.join(", ")} (CLIPY_TRANSCRIBE_MODEL or "transcription.model", config file: ${path}).`,
        );
      }
      return { kind: "local", model: model as LocalTranscriptionModel };
    }
    case "openai":
    case "groq": {
      if (!draft.apiKey) throw needKey(draft.kind === "openai" ? "OpenAI" : "Groq");
      const preset = TRANSCRIPTION_PRESETS[draft.kind];
      return { kind: "openai-compatible", baseUrl: preset.baseUrl, apiKey: draft.apiKey, model: draft.model ?? preset.model };
    }
    case "openai-compatible": {
      if (!draft.baseUrl) {
        throw new ConfigError(
          `OpenAI-compatible transcription needs a base URL. Set CLIPY_TRANSCRIBE_BASE_URL or "transcription.baseUrl" (config file: ${path}).`,
        );
      }
      if (!draft.model) {
        throw new ConfigError(
          `OpenAI-compatible transcription needs a model name. Set CLIPY_TRANSCRIBE_MODEL or "transcription.model" (config file: ${path}).`,
        );
      }
      return { kind: "openai-compatible", baseUrl: draft.baseUrl, apiKey: draft.apiKey ?? "", model: draft.model };
    }
    default: {
      if (!draft.apiKey) throw needKey(draft.kind);
      return draft.model
        ? { kind: draft.kind, apiKey: draft.apiKey, model: draft.model }
        : { kind: draft.kind, apiKey: draft.apiKey };
    }
  }
}

function defaultTranscriptionModel(kind: StoredTranscriptionKind): string | undefined {
  return kind === "openai" || kind === "groq" ? TRANSCRIPTION_PRESETS[kind].model : undefined;
}

/**
 * The user's settings: the file at `configPath(env)` with env vars on top. A
 * missing file gives the defaults (rules only, local "English, fast"
 * transcription). Throws a ConfigError, safe to print, when the file is
 * malformed or a provider is missing something it needs.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LocalConfig {
  const path = configPath(env);
  const stored = readStored(path);
  const { model, modelPreset } = resolveModel(stored.model, env, path);
  return { model, modelPreset, transcription: resolveTranscription(stored.transcription, env, path), telemetry: false };
}

/**
 * Report where the settings selected by the merge came from. The report
 * contains only source labels and notes, so it can be shared without values.
 * It can explain overrides even when required settings for the selected
 * provider are missing. Use loadConfig to validate the resolved settings.
 */
export function explainConfig(env: NodeJS.ProcessEnv = process.env): ConfigExplanation {
  const stored = readStored(configPath(env));
  const model = mergeModel(stored.model, env);
  const transcription = mergeTranscription(stored.transcription, env);
  return { model: model.sources, transcription: transcription.sources, notes: [...model.notes, ...transcription.notes] };
}

/**
 * Update the settings file. Each top-level field in `patch` replaces the saved
 * one whole (`model: null` clears the provider); fields left out, or
 * undefined, are kept. Creates the directory if needed and writes the file
 * with mode 0600, replacing it in one step so a crash never leaves half a
 * file. Env vars are not written. Refuses to overwrite a malformed file.
 */
export function saveConfig(patch: Partial<StoredConfig>, env: NodeJS.ProcessEnv = process.env): void {
  const path = configPath(env);
  const next: StoredFile = { ...readStored(path), version: 1 };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  const parsed = storedConfigSchema.safeParse(next);
  if (!parsed.success) throw new ConfigError(`Cannot save settings: ${describeIssues(parsed.error)}.`);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(`Cannot write the config file ${path} (${code ?? "unknown error"}).`);
  }
}
