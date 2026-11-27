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
  | { kind: "none"; language?: string }
  | { kind: "local"; model?: LocalTranscriptionModel; language?: string }
  | { kind: "openai" | "groq"; apiKey: string; model?: string; language?: string }
  | { kind: "openai-compatible"; baseUrl: string; apiKey?: string; model: string; language?: string }
  | { kind: (typeof KEYED_TRANSCRIPTION_KINDS)[number]; apiKey: string; model?: string; language?: string };
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

const nonEmpty = z.string().trim().min(1, "must not be empty");
const ISO_639_1_CODES = new Set(
  `aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs
  ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi
  fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig
  ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky
  la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne
  ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw
  sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti
  tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu`
    .split(/\s+/)
    .filter(Boolean),
);

const languageCode = z.string().refine(
  (value) => ISO_639_1_CODES.has(value),
  "must be a valid two-letter ISO 639-1 language code",
);const httpUrl = z.string().trim().refine(isHttpUrl, HTTP_URL_MESSAGE);

const storedModelSchema = z.strictObject({
  preset: z.enum(MODEL_PRESETS),
  apiKey: nonEmpty.optional(),
  model: nonEmpty.optional(),
  baseUrl: httpUrl.optional(),
});

const storedTranscriptionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none"), language: languageCode.optional() }),
  z.strictObject({ kind: z.literal("local"), model: z.enum(LOCAL_TRANSCRIPTION_MODELS).optional(), language: languageCode.optional() }),
  z.strictObject({ kind: z.enum(["openai", "groq"]), apiKey: nonEmpty, model: nonEmpty.optional(), language: languageCode.optional() }),
  z.strictObject({ kind: z.literal("openai-compatible"), baseUrl: httpUrl, apiKey: nonEmpty.optional(), model: nonEmpty, language: languageCode.optional() }),
  z.strictObject({ kind: z.enum(KEYED_TRANSCRIPTION_KINDS), apiKey: nonEmpty, model: nonEmpty.optional(), language: languageCode.optional() }),
]);

export const storedConfigSchema = z.looseObject({
  version: z.literal(1).optional(),
  model: storedModelSchema.nullable().optional(),
  transcription: storedTranscriptionSchema.optional(),
});

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
