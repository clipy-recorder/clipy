import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEYED_TRANSCRIPTION_KINDS,
  LOCAL_TRANSCRIPTION_MODELS,
  MODEL_PRESETS,
  storedConfigSchema,
  TRANSCRIPTION_KINDS,
} from "../src/schema.js";

describe("JSON Schema (config.schema.json)", () => {
  const schemaPath = join(__dirname, "..", "config.schema.json");
  const schemaContent = readFileSync(schemaPath, "utf8");
  const schema = JSON.parse(schemaContent);

  it("is valid JSON and targets Draft 2020-12", () => {
    expect(schema).toBeDefined();
    expect(schema.$schema).toContain("draft/2020-12");
    expect(schema.title).toBe("ClipyConfig");
    expect(schema.type).toBe("object");
  });

  it("covers every model preset defined in the TypeScript schema", () => {
    const modelPresetsInSchema: string[] = schema.properties.model.properties.preset.enum;
    expect(modelPresetsInSchema).toEqual([...MODEL_PRESETS]);
  });

  it("covers every local model and transcription variant", () => {
    const oneOf: Array<{ properties: Record<string, any>; required: string[] }> =
      schema.properties.transcription.oneOf;

    // Check 'none'
    const noneVariant = oneOf.find((v) => v.properties.kind?.const === "none");
    expect(noneVariant).toBeDefined();

    // Check 'local'
    const localVariant = oneOf.find((v) => v.properties.kind?.const === "local");
    expect(localVariant).toBeDefined();
    expect(localVariant?.properties.model.enum).toEqual([...LOCAL_TRANSCRIPTION_MODELS]);

    // Check 'openai-compatible'
    const openaiCompatVariant = oneOf.find((v) => v.properties.kind?.const === "openai-compatible");
    expect(openaiCompatVariant).toBeDefined();
    expect(openaiCompatVariant?.required).toContain("baseUrl");
    expect(openaiCompatVariant?.required).toContain("model");

    // Check keyed transcription kinds
    const keyedVariant = oneOf.find((v) =>
      Array.isArray(v.properties.kind?.enum) &&
      v.properties.kind.enum.includes("deepgram")
    );
    expect(keyedVariant).toBeDefined();
    expect(keyedVariant?.properties.kind.enum).toEqual([...KEYED_TRANSCRIPTION_KINDS]);
  });

  it("accepts valid config examples matching storedConfigSchema", () => {
    const validConfigs = [
      {},
      { version: 1 },
      {
        version: 1,
        model: { preset: "openrouter", apiKey: "sk-or-v1-test" },
        transcription: { kind: "local", model: "english-fast" },
      },
      {
        model: { preset: "ollama", model: "llama3.2", baseUrl: "http://127.0.0.1:11434/v1" },
        transcription: { kind: "none" },
      },
      {
        transcription: {
          kind: "openai-compatible",
          baseUrl: "http://localhost:8080/v1",
          model: "whisper-1",
        },
      },
    ];

    for (const cfg of validConfigs) {
      expect(() => storedConfigSchema.parse(cfg)).not.toThrow();
    }
  });

  it("rejects invalid configs matching storedConfigSchema validation rules", () => {
    const invalidConfigs = [
      { model: { preset: "unsupported-preset" } },
      { model: { preset: "openrouter", baseUrl: "not-a-url" } },
      { transcription: { kind: "unknown-kind" } },
      { transcription: { kind: "openai-compatible", baseUrl: "not-a-url", model: "whisper" } },
      { transcription: { kind: "local", model: "non-existent-model" } },
    ];

    for (const cfg of invalidConfigs) {
      expect(() => storedConfigSchema.parse(cfg)).toThrow();
    }
  });
});
