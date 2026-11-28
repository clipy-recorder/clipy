/** Deepgram pre-recorded `/v1/listen`, with utterances for segment boundaries. */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { joinUrl, ProviderError, requestJson } from "./http.js";
import { groupWordsIntoSegments, toTimeline, type RelativeSegment } from "../chunking.js";
import { speakerField, type AudioInput, type EngineOutput } from "./common.js";

export const DEEPGRAM_BASE_URL = "https://api.deepgram.com";
export const DEEPGRAM_DEFAULT_MODEL = "nova-3";

const SpeakerId = z.union([z.number(), z.string()]).nullish();
const Word = z
  .object({ start: z.number(), end: z.number(), word: z.string(), punctuated_word: z.string().optional(), speaker: SpeakerId })
  .passthrough();
const Answer = z.object({
  results: z
    .object({
      utterances: z.array(z.object({ start: z.number(), end: z.number(), transcript: z.string(), speaker: SpeakerId }).passthrough()).nullish(),
      channels: z
        .array(
          z
            .object({
              detected_language: z.string().optional(),
              alternatives: z.array(z.object({ transcript: z.string().optional(), words: z.array(Word).optional() }).passthrough()).optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough(),
});

export async function transcribeDeepgram(
  input: AudioInput,
  config: { apiKey: string; model?: string; baseUrl?: string; diarize?: boolean },
): Promise<EngineOutput> {
  const provider = "deepgram";
  const model = config.model || DEEPGRAM_DEFAULT_MODEL;
  const params = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    utterances: "true",
    detect_language: "true",
  });
  if (config.diarize) params.set("diarize", "true");
  const url = `${joinUrl(config.baseUrl || DEEPGRAM_BASE_URL, "v1/listen")}?${params}`;
  const audio = await readFile(input.wavPath);
  const raw = await requestJson(
    provider,
    url,
    { method: "POST", headers: { Authorization: `Token ${config.apiKey}`, "Content-Type": "audio/wav" }, body: new Uint8Array(audio) },
    input.signal,
  );
  const parsed = Answer.safeParse(raw);
  if (!parsed.success) throw new ProviderError(provider, 200, "unexpected answer shape");
  const channel = parsed.data.results.channels?.[0];
  let segments: RelativeSegment[];
  const utterances = parsed.data.results.utterances;
  if (utterances && utterances.length > 0) {
    segments = utterances.map((u) => ({ start: u.start, end: u.end, text: u.transcript, ...speakerField(u.speaker, config.diarize) }));
  } else {
    const words = channel?.alternatives?.[0]?.words ?? [];
    segments = groupWordsIntoSegments(
      words.map((w) => ({ start: w.start, end: w.end, text: w.punctuated_word ?? w.word, ...speakerField(w.speaker, config.diarize) })),
    );
  }
  input.onProgress?.(1);
  return {
    segments: toTimeline(segments),
    language: channel?.detected_language,
    engine: `deepgram:${model}`,
    gaps: [],
  };
}
