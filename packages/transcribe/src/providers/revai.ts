/** Rev.ai async Speech-to-Text `/speechtotext/v1/jobs`: upload audio, poll until transcribed, and group words into segments. */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { throwIfAborted } from "../audio.js";
import { groupWordsIntoSegments, toTimeline, type TimedWord } from "../chunking.js";
import type { AudioInput, EngineOutput } from "./common.js";
import { joinUrl, ProviderError, requestJson, sleep } from "./http.js";

export const REVAI_BASE_URL = "https://api.rev.ai";

const REVAI_TRANSCRIPT_ACCEPT = "application/vnd.rev.transcript.v1.0+json";

const Job = z
  .object({
    id: z.string().min(1),
    status: z.string(),
    language: z.string().nullish(),
  })
  .passthrough();

const TranscriptElement = z
  .object({
    type: z.string(),
    value: z.string().optional(),
    ts: z.number().nullish(),
    end_ts: z.number().nullish(),
  })
  .passthrough();

const Transcript = z
  .object({
    monologues: z
      .array(
        z
          .object({
            elements: z.array(TranscriptElement).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export interface RevAILimits {
  pollIntervalMs?: number;
  /** Give up after this long; long recordings take a while to process. */
  timeoutMs?: number;
}

function extractWords(monologues: z.infer<typeof Transcript>["monologues"]): TimedWord[] {
  const words: TimedWord[] = [];
  for (const monologue of monologues ?? []) {
    for (const el of monologue.elements ?? []) {
      if (el.type === "text") {
        if (
          typeof el.value === "string" &&
          el.value.trim() !== "" &&
          typeof el.ts === "number" &&
          Number.isFinite(el.ts) &&
          typeof el.end_ts === "number" &&
          Number.isFinite(el.end_ts)
        ) {
          const start = Math.max(0, el.ts);
          words.push({ start, end: Math.max(el.end_ts, start), text: el.value });
        }
      } else if (el.type === "punct" && typeof el.value === "string") {
        const punct = el.value.trim();
        if (punct && words.length > 0) {
          words[words.length - 1].text += punct;
        }
      }
    }
  }
  return words;
}

export async function transcribeRevAI(
  input: AudioInput,
  config: { apiKey: string; model?: string; baseUrl?: string },
  limits: RevAILimits = {},
): Promise<EngineOutput> {
  const provider = "revai";
  const base = config.baseUrl || REVAI_BASE_URL;
  const model = config.model?.trim() || undefined;
  const auth = { Authorization: `Bearer ${config.apiKey}` };
  const pollMs = limits.pollIntervalMs ?? 3000;
  const timeoutMs = limits.timeoutMs ?? 60 * 60 * 1000;

  throwIfAborted(input.signal);
  const audio = await readFile(input.wavPath);
  const form = new FormData();
  form.append("media", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "audio.wav");
  if (model) {
    form.append("options", JSON.stringify({ transcriber: model }));
  }

  const created = Job.safeParse(
    await requestJson(
      provider,
      joinUrl(base, "speechtotext/v1/jobs"),
      { method: "POST", headers: auth, body: form },
      input.signal,
    ),
  );
  if (!created.success) throw new ProviderError(provider, 200, "unexpected answer shape");
  input.onProgress?.(0.2);

  const started = Date.now();
  let job = created.data;
  const jobUrl = joinUrl(base, `speechtotext/v1/jobs/${encodeURIComponent(job.id)}`);
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(), timeoutMs);
  const pollSignal = input.signal ? AbortSignal.any([input.signal, clock.signal]) : clock.signal;
  try {
    while (job.status !== "transcribed") {
      if (job.status === "failed") throw new ProviderError(provider, undefined, "the provider reported an error for this audio");
      if (clock.signal.aborted || Date.now() - started >= timeoutMs) {
        throw new ProviderError(provider, undefined, "timed out waiting for the transcript");
      }
      try {
        await sleep(pollMs, pollSignal);
        const next = Job.safeParse(await requestJson(provider, jobUrl, { headers: auth }, pollSignal));
        if (!next.success) throw new ProviderError(provider, 200, "unexpected answer shape");
        job = next.data;
      } catch (err) {
        if (clock.signal.aborted && !input.signal?.aborted) {
          throw new ProviderError(provider, undefined, "timed out waiting for the transcript");
        }
        throw err;
      }
      input.onProgress?.(Math.min(0.95, 0.2 + (Date.now() - started) / Math.max(60_000, input.info.durationSec * 300)));
    }
  } finally {
    clearTimeout(timer);
  }

  const transcript = Transcript.safeParse(
    await requestJson(
      provider,
      joinUrl(base, `speechtotext/v1/jobs/${encodeURIComponent(job.id)}/transcript`),
      { headers: { ...auth, Accept: REVAI_TRANSCRIPT_ACCEPT } },
      input.signal,
    ),
  );
  if (!transcript.success) throw new ProviderError(provider, 200, "unexpected answer shape");

  const words = extractWords(transcript.data.monologues);
  input.onProgress?.(1);
  return {
    segments: toTimeline(groupWordsIntoSegments(words)),
    language: job.language || undefined,
    engine: `revai${model ? `:${model}` : ""}`,
    gaps: [],
  };
}
