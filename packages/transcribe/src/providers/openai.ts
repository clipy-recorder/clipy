/**
 * Any OpenAI-compatible `/audio/transcriptions` endpoint: OpenAI (`whisper-1`,
 * `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`), Groq (`whisper-large-v3-turbo`,
 * `whisper-large-v3`), or a self-hosted server speaking the same API.
 *
 * Segment timestamps need `response_format=verbose_json` with
 * `timestamp_granularities[]=segment`. OpenAI's `gpt-4o-*-transcribe` models
 * accept only `json` (plain text, no timestamps), so they are sent that and
 * no granularity field, and each piece's text becomes one segment trimmed to
 * the speech in that piece. Every other model gets `verbose_json`.
 */
import { z } from "zod";
import { joinUrl, ProviderError, requestJson } from "./http.js";
import { maxSecForBytes, runInPieces, wholePieceSegment, type AudioInput, type EngineOutput } from "./common.js";

/**
 * OpenAI's GPT-4o transcription models, dated snapshots and the diarize
 * variant included (`gpt-4o-mini-transcribe-2025-12-15`,
 * `gpt-4o-transcribe-diarize`), also behind a `vendor/` prefix.
 */
export function isTextOnlyModel(model: string): boolean {
  return /(?:^|\/)gpt-4o(?:-mini)?-transcribe(?:-|$)/i.test(model.trim());
}

/** OpenAI rejects uploads over 25 MB; stay under it with room for the form. */
export const OPENAI_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const VerboseJson = z.object({
  text: z.string().optional(),
  language: z.string().optional(),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string() }).passthrough())
    .nullish(),
});

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export async function transcribeOpenAICompatible(
  input: AudioInput,
  config: OpenAICompatibleConfig,
  limits: { maxUploadBytes?: number } = {},
): Promise<EngineOutput> {
  const provider = "openai-compatible";
  const maxSec = maxSecForBytes(limits.maxUploadBytes ?? OPENAI_MAX_UPLOAD_BYTES);
  const url = joinUrl(config.baseUrl, "audio/transcriptions");
  const textOnly = isTextOnlyModel(config.model);
  const { segments, language, gaps } = await runInPieces(input, { maxSec, targetSec: Math.min(600, Math.floor(maxSec * 0.8)) }, async (wav, durSec, silences) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", config.model);
    if (textOnly) {
      form.append("response_format", "json");
    } else {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
    }
    const headers: Record<string, string> = {};
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const raw = await requestJson(provider, url, { method: "POST", headers, body: form }, input.signal);
    const parsed = VerboseJson.safeParse(raw);
    if (!parsed.success) throw new ProviderError(provider, 200, "unexpected answer shape");
    const segs = parsed.data.segments;
    if (segs && segs.length > 0) {
      return { language: parsed.data.language, segments: segs.map((s) => ({ start: s.start, end: s.end, text: s.text })) };
    }
    // Plain text only, always the case for the GPT-4o models: one segment, trimmed
    // to the speech in the piece for them (other models keep their old behaviour).
    const text = parsed.data.text ?? "";
    return { language: parsed.data.language, segments: wholePieceSegment(text, durSec, textOnly && text.trim() ? await silences() : []) };
  });
  return { segments, language, engine: `openai-compatible:${config.model}`, gaps };
}
