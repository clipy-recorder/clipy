import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/index.js";
import {
  buildConfigJsonSchema,
  KEYED_TRANSCRIPTION_KINDS,
  LOCAL_TRANSCRIPTION_MODELS,
  MODEL_PRESETS,
  storedConfigSchema,
} from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");
const schemaPath = join(pkgDir, "config.schema.json");
const schemaSourcePath = join(pkgDir, "src", "schema.ts");

type JsonSchemaNode = {
  $schema?: string;
  title?: string;
  description?: string;
  format?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
};

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "title",
  "description",
  "format",
  "type",
  "const",
  "enum",
  "minLength",
  "pattern",
  "properties",
  "required",
  "additionalProperties",
  "anyOf",
  "oneOf",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canParseUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Validate `value` against the JSON Schema subset emitted by `z.toJSONSchema`. */
function validateJsonSchema(schema: JsonSchemaNode, value: unknown, path = "$"): string[] {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword "${key}" at ${path}; extend validateJsonSchema.`);
    }
  }

  const errors: string[] = [];

  if (schema.type !== undefined) {
    const matchesType =
      (schema.type === "object" && isPlainObject(value)) ||
      (schema.type === "null" && value === null) ||
      (schema.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (schema.type === "string" && typeof value === "string");
    if (!matchesType) {
      return [`${path}: expected ${schema.type}`];
    }
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${path}: expected constant ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined && !schema.enum.some((item) => Object.is(value, item))) {
    errors.push(`${path}: expected one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: length must be >= ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: must match pattern ${schema.pattern}`);
    }
    if (schema.format === "uri" && !canParseUrl(value)) {
      errors.push(`${path}: must be a valid URI`);
    }
  }

  if (isPlainObject(value)) {
    for (const req of schema.required ?? []) {
      if (!Object.hasOwn(value, req)) {
        errors.push(`${path}: missing required property "${req}"`);
      }
    }

    const props = schema.properties ?? {};
    for (const [key, propValue] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (Object.hasOwn(props, key)) {
        errors.push(...validateJsonSchema(props[key], propValue, childPath));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validateJsonSchema(schema.additionalProperties as JsonSchemaNode, propValue, childPath));
      }
    }
  }

  if (schema.anyOf !== undefined) {
    const branchErrors = schema.anyOf.map((branch) => validateJsonSchema(branch, value, path));
    if (!branchErrors.some((errs) => errs.length === 0)) {
      errors.push(`${path}: did not match anyOf (${branchErrors.map((e) => e[0]).join(" | ")})`);
    }
  }

  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((branch) => validateJsonSchema(branch, value, path).length === 0);
    if (matches.length !== 1) {
      errors.push(`${path}: expected exactly 1 oneOf match, got ${matches.length}`);
    }
  }

  return errors;
}

function loadCheckedInSchema(): { text: string; parsed: JsonSchemaNode } {
  const text = readFileSync(schemaPath, "utf8").replace(/\r\n/g, "\n");
  return { text, parsed: JSON.parse(text) as JsonSchemaNode };
}

function extractStoredConfigDocExample(): unknown {
  const source = readFileSync(schemaSourcePath, "utf8").replace(/\r\n/g, "\n");
  const match = /Example:\s*\n\s*\*\s*\n\s*\*\s*```json\n([\s\S]*?)\n\s*\*\s*```[\s\S]*?export interface StoredConfig/.exec(
    source,
  );
  if (!match) {
    throw new Error("Could not find JSON example in StoredConfig doc comment");
  }
  const jsonText = match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""))
    .join("\n");
  return JSON.parse(jsonText);
}

describe("config.schema.json", () => {
  it("matches storedConfigSchema (fails when schema.ts changes without regenerating)", () => {
    const { text, parsed } = loadCheckedInSchema();
    const expected = buildConfigJsonSchema();
    const expectedText = `${JSON.stringify(expected, null, 2)}\n`;

    expect(parsed).toEqual(expected);
    expect(text, "config.schema.json is stale; run: pnpm --filter @clipy/local-config run schema").toBe(expectedText);
  });

  it("validates the example in the StoredConfig doc comment", () => {
    const { parsed } = loadCheckedInSchema();
    const example = extractStoredConfigDocExample();

    expect(storedConfigSchema.safeParse(example).success).toBe(true);
    expect(validateJsonSchema(parsed, example)).toEqual([]);
  });

  it("allows and preserves $schema and unknown top-level keys", () => {
    const { parsed } = loadCheckedInSchema();
    expect(parsed.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(parsed.additionalProperties).toEqual({});

    const withSchema = {
      $schema: "./config.schema.json",
      version: 1,
      model: null,
      futureSetting: { enabled: true },
    };
    expect(storedConfigSchema.safeParse(withSchema).success).toBe(true);
    expect(validateJsonSchema(parsed, withSchema)).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "clipy-schema-test-"));
    try {
      const file = join(dir, "config.json");
      const env = { CLIPY_LOCAL_CONFIG: file };
      writeFileSync(file, JSON.stringify(withSchema));
      expect(loadConfig(env).model).toBeNull();
      saveConfig({ transcription: { kind: "none" } }, env);
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(saved.$schema).toBe("./config.schema.json");
      expect(saved.futureSetting).toEqual({ enabled: true });
      expect(loadConfig(env).transcription).toEqual({ kind: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts all valid model presets and transcription kinds", () => {
    const { parsed } = loadCheckedInSchema();

    const validConfigs: unknown[] = [
      {},
      { version: 1, model: null, transcription: { kind: "none" } },
      ...MODEL_PRESETS.map((preset) => ({
        model:
          preset === "custom"
            ? { preset, baseUrl: "http://127.0.0.1:8080/v1", model: "local-llm" }
            : preset === "ollama" || preset === "lmstudio"
              ? { preset, model: "llama3.2" }
              : { preset, apiKey: "sk-test" },
      })),
      { transcription: { kind: "local" } },
      ...LOCAL_TRANSCRIPTION_MODELS.map((model) => ({ transcription: { kind: "local", model } })),
      { transcription: { kind: "openai", apiKey: "sk-test" } },
      { transcription: { kind: "groq", apiKey: "gsk-test", model: "whisper-large-v3-turbo" } },
      { transcription: { kind: "openai-compatible", baseUrl: "https://stt.example.com/v1", model: "whisper-1" } },
      { transcription: { kind: "openai-compatible", baseUrl: "http://localhost:8000/v1", apiKey: "k", model: "large-v3" } },
      ...KEYED_TRANSCRIPTION_KINDS.map((kind) => ({ transcription: { kind, apiKey: "key-123" } })),
    ];

    for (const cfg of validConfigs) {
      expect(storedConfigSchema.safeParse(cfg).success).toBe(true);
      expect(validateJsonSchema(parsed, cfg)).toEqual([]);
    }
  });

  it("rejects invalid configs, nested typos, blank strings, and bad URLs", () => {
    const { parsed } = loadCheckedInSchema();

    const invalidConfigs: unknown[] = [
      null,
      [],
      "config",
      42,
      { version: 2 },
      { version: "1" },
      { model: { preset: "anthropic" } },
      { model: { apiKey: "sk-test" } },
      { model: { preset: "openai", apikey: "sk-test" } },
      { model: { preset: "openai", apiKey: "" } },
      { model: { preset: "openai", apiKey: "   " } },
      { model: { preset: "custom", baseUrl: "ftp://example.com", model: "m" } },
      { model: { preset: "custom", baseUrl: "not-a-url", model: "m" } },
      { model: { preset: "custom", baseUrl: "http://", model: "m" } },
      { transcription: { kind: "whisper" } },
      { transcription: { kind: "local", model: "huge" } },
      { transcription: { kind: "local", unknownField: true } },
      { transcription: { kind: "openai" } },
      { transcription: { kind: "openai", apiKey: "   " } },
      { transcription: { kind: "deepgram", apiKey: "dg-123", apikey: "typo" } },
      { transcription: { kind: "openai-compatible", baseUrl: "https://stt.example.com/v1" } },
      { transcription: { kind: "openai-compatible", model: "whisper-1" } },
    ];

    for (const cfg of invalidConfigs) {
      expect(storedConfigSchema.safeParse(cfg).success).toBe(false);
      expect(validateJsonSchema(parsed, cfg).length).toBeGreaterThan(0);
    }
  });
});
