import { z } from "zod";

export const MODEL_PRESETS = ["openrouter", "openai", "gemini", "groq", "ollama", "lmstudio", "custom"] as const;
export type ModelPreset = (typeof MODEL_PRESETS)[number];

export const LOCAL_TRANSCRIPTION_MODELS = ["english-fast", "multilingual"] as const;
export type LocalTranscriptionModel = (typeof LOCAL_TRANSCRIPTION_MODELS)[number];

/** Hosted transcription services that take only a key (and optionally a model). */
export const KEYED_TRANSCRIPTION_KINDS = ["deepgram", "assemblyai", "elevenlabs", "gemini"] as const;

/** Every value `transcription.kind` and `CLIPY_TRANSCRIBE` accept. */
export const TRANSCRIPTION_KINDS = [
  "none",
  "local",
  "openai",
  "groq",
  "openai-compatible",
  ...KEYED_TRANSCRIPTION_KINDS,
] as const;
export type StoredTranscriptionKind = (typeof TRANSCRIPTION_KINDS)[number];

/** The model provider as saved in the file. */
export interface StoredModel {
  /** Which provider. `custom` is any other OpenAI-compatible endpoint. */
  preset: ModelPreset;
  /** Required for openrouter, openai, gemini and groq. */
  apiKey?: string;
  /** Defaults per preset; required for ollama, lmstudio and custom. */
  model?: string;
  /** Required for custom. For a preset, replaces its URL (for example Ollama on another host). */
  baseUrl?: string;
}

/**
 * Transcription as saved in the file. `openai` and `groq` are shorthands for
 * their OpenAI-compatible endpoints and default models.
 */
export type StoredTranscription =
  | { kind: "none" }
  | { kind: "local"; model?: LocalTranscriptionModel }
  | { kind: "openai" | "groq"; apiKey: string; model?: string }
  | { kind: "openai-compatible"; baseUrl: string; apiKey?: string; model: string }
  | { kind: (typeof KEYED_TRANSCRIPTION_KINDS)[number]; apiKey: string; model?: string };

/**
 * The settings file (`config.json`, mode 0600). Every field is optional; a
 * missing file means all defaults. Example:
 *
 * ```json
 * {
 *   "version": 1,
 *   "model": { "preset": "openrouter", "apiKey": "sk-or-..." },
 *   "transcription": { "kind": "local", "model": "english-fast" }
 * }
 * ```
 *
 * - `model`: the provider that reads the transcript for spoken cues. Absent or
 *   null means rules only, and nothing leaves the machine.
 * - `transcription`: how recordings are transcribed. Defaults to the local
 *   "English, fast" model.
 *
 * Unknown top-level keys are kept, so a newer version's settings survive a
 * save from an older one. Inside `model` and `transcription` unknown keys are
 * errors, which catches typos such as `apikey`.
 *
 * Editors such as VS Code can validate and autocomplete `config.json` when you
 * add a top-level `"$schema"` key pointing to `config.schema.json` (generated
 * from `storedConfigSchema` via `pnpm --filter @clipy/local-config run schema`).
 * Because the root schema keeps unknown keys (`z.looseObject` ->
 * `"additionalProperties": {}`), `"$schema"` is both accepted by editors and
 * preserved by `loadConfig` / `saveConfig`, while `model` and `transcription`
 * stay strict (`"additionalProperties": false`).
 */
export interface StoredConfig {
  version?: 1;
  model?: StoredModel | null;
  transcription?: StoredTranscription;
}

const HTTP_URL_MESSAGE = "must be an http:// or https:// URL";

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const nonEmpty = z.string().trim().min(1, "must not be empty").meta({ pattern: "\\S" });
const httpUrl = z
  .string()
  .trim()
  .refine(isHttpUrl, HTTP_URL_MESSAGE)
  .meta({ format: "uri", pattern: "^\\s*https?://\\S+" });

const storedModelSchema = z.strictObject({
  preset: z.enum(MODEL_PRESETS).describe("Model provider preset. Use \"custom\" for any other OpenAI-compatible endpoint."),
  apiKey: nonEmpty.optional().describe("API key for hosted presets (required for openrouter, openai, gemini, and groq)."),
  model: nonEmpty.optional().describe("Model identifier. Optional for hosted presets; required for ollama, lmstudio, and custom."),
  baseUrl: httpUrl.optional().describe("HTTP(S) endpoint URL. Required for custom; overrides the default URL for other presets."),
});

const storedTranscriptionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("none").describe("Disable transcription."),
    }),
    z.strictObject({
      kind: z.literal("local").describe("Transcribe locally on device using downloaded models."),
      model: z.enum(LOCAL_TRANSCRIPTION_MODELS).optional().describe("Local speech model (defaults to \"english-fast\")."),
    }),
    z.strictObject({
      kind: z.enum(["openai", "groq"]).describe("Hosted OpenAI or Groq transcription shorthand."),
      apiKey: nonEmpty.describe("API key for the selected transcription provider."),
      model: nonEmpty.optional().describe("Model name overriding the preset default."),
    }),
    z.strictObject({
      kind: z.literal("openai-compatible").describe("Custom OpenAI-compatible /audio/transcriptions endpoint."),
      baseUrl: httpUrl.describe("Base HTTP(S) URL of the OpenAI-compatible server."),
      apiKey: nonEmpty.optional().describe("Optional API key if the server requires authentication."),
      model: nonEmpty.describe("Model name expected by the server."),
    }),
    z.strictObject({
      kind: z.enum(KEYED_TRANSCRIPTION_KINDS).describe("Hosted transcription provider taking an API key."),
      apiKey: nonEmpty.describe("API key for the transcription provider."),
      model: nonEmpty.optional().describe("Optional provider-specific model name."),
    }),
  ])
  .describe("How recordings are transcribed. Defaults to the local \"english-fast\" model.");

export const storedConfigSchema = z
  .looseObject({
    version: z.literal(1).optional().describe("Config file format version (currently 1)."),
    model: storedModelSchema
      .nullable()
      .optional()
      .describe("Provider that reads the transcript for spoken cues. Omit or set to null for rules-only mode."),
    transcription: storedTranscriptionSchema.optional(),
  })
  .meta({
    title: "Clipy Local Configuration",
    description:
      "Settings file (config.json) for @clipy/local-config. Unknown top-level keys (such as \"$schema\") are preserved; model and transcription reject unknown keys.",
  });

/** Generate the Draft 2020-12 JSON Schema for `config.json` from `storedConfigSchema`. */
export function buildConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(storedConfigSchema) as Record<string, unknown>;
}

/**
 * One line per problem, naming the field. Zod issues here never carry the
 * input value, so a key in the file cannot end up in the message.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.map(String);
      let message = issue.message;
      if (issue.code === "invalid_union" && "discriminator" in issue && typeof issue.discriminator === "string") {
        if (path[path.length - 1] !== issue.discriminator) path.push(issue.discriminator);
        message = `must be one of ${TRANSCRIPTION_KINDS.join(", ")}`;
      }
      const field = path.length ? `"${path.join(".")}"` : "the file";
      return path.length ? `${field}: ${message}` : `${field} must contain a JSON object`;
    })
    .join("; ");
}
