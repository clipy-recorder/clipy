import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transcribe } from "../src/index.js";
import { transcribeAssemblyAI } from "../src/providers/assemblyai.js";
import { transcribeDeepgram } from "../src/providers/deepgram.js";
import { transcribeElevenLabs } from "../src/providers/elevenlabs.js";
import { transcribeGemini } from "../src/providers/gemini.js";
import { ProviderError, requestJson } from "../src/providers/http.js";
import { transcribeOpenAICompatible } from "../src/providers/openai.js";
import { audioInput, fakeServer, formData, json, tempDir, wavSeconds, type FakeServer } from "./helpers.js";

const KEY = "fake-test-key-SECRETKEY-123";
const SECRET_TEXT = "the-secret-transcript-words";

let server: FakeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

/** A failing provider: errors name provider and status, never the key or the body. */
async function expectSafeError(p: Promise<unknown>, provider: string, status: number): Promise<ProviderError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  const msg = (err as Error).message;
  expect(msg).toContain(provider);
  expect(msg).toContain(String(status));
  expect(msg).not.toContain(KEY);
  expect(msg).not.toContain(SECRET_TEXT);
  expect((err as ProviderError).status).toBe(status);
  return err as ProviderError;
}

describe("openai-compatible", () => {
  it("posts verbose_json with segment timestamps and maps seconds to ms", async () => {
    server = await fakeServer(async (req, res) => {
      json(res, {
        text: "hello world. second",
        language: "english",
        segments: [
          { id: 0, start: 0.5, end: 1.25, text: " hello world." },
          { id: 1, start: 1.5, end: 2.0, text: " second" },
        ],
      });
    });
    const input = await audioInput(3);
    const r = await transcribeOpenAICompatible(input, { baseUrl: `${server.url}/v1/`, apiKey: KEY, model: "whisper-1" });
    expect(r.segments).toEqual([
      { startMs: 500, endMs: 1250, text: "hello world." },
      { startMs: 1500, endMs: 2000, text: "second" },
    ]);
    expect(r.language).toBe("english");
    expect(r.engine).toBe("openai-compatible:whisper-1");
    expect(input.progress.at(-1)).toBe(1);

    const [req] = server.requests;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/audio/transcriptions");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    const form = await formData(req);
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment"]);
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(44 + 3 * 32000);
  });

  it("splits audio over the upload limit at silences and offsets each piece", async () => {
    const seen: number[] = [];
    server = await fakeServer(async (req, res) => {
      const file = (await formData(req)).get("file") as File;
      const dur = wavSeconds(Buffer.from(await file.arrayBuffer()));
      seen.push(dur);
      json(res, { segments: [{ start: 0.5, end: 1.5, text: `piece ${seen.length}` }] });
    });
    // 25 s of audio, 10 s upload limit, silences at 7-8 and 16-17 s.
    const input = await audioInput(25, [
      { startSec: 7, endSec: 8 },
      { startSec: 16, endSec: 17 },
    ]);
    const r = await transcribeOpenAICompatible(input, { baseUrl: server.url, apiKey: KEY, model: "m" }, { maxUploadBytes: 44 + 10 * 32000 });
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s <= 10)).toBe(true);
    expect(seen.map((s) => Math.round(s * 10) / 10)).toEqual([7.5, 9, 8.5]);
    expect(r.segments).toEqual([
      { startMs: 500, endMs: 1500, text: "piece 1" },
      { startMs: 8000, endMs: 9000, text: "piece 2" },
      { startMs: 17000, endMs: 18000, text: "piece 3" },
    ]);
  });

  it("sends no Authorization header when the key is empty (local servers)", async () => {
    server = await fakeServer((_req, res) => json(res, { text: "just text" }));
    const r = await transcribeOpenAICompatible(await audioInput(2), { baseUrl: server.url, apiKey: "", model: "m" });
    expect(server.requests[0].headers.authorization).toBeUndefined();
    // No segments: one segment over the piece.
    expect(r.segments).toEqual([{ startMs: 0, endMs: 2000, text: "just text" }]);
  });

  it("reports HTTP errors without the key or the body", async () => {
    server = await fakeServer((_req, res) => json(res, { error: { message: `bad key ${KEY} ${SECRET_TEXT}` } }, 401));
    await expectSafeError(transcribeOpenAICompatible(await audioInput(1), { baseUrl: server.url, apiKey: KEY, model: "m" }), "openai-compatible", 401);
  });

  it("works end to end through transcribe() from a media file", async () => {
    server = await fakeServer((_req, res) => json(res, { language: "en", segments: [{ start: 0, end: 1, text: "ok" }] }));
    const dir = tempDir();
    const media = join(dir, "tone.m4a");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=2", "-c:a", "aac", media]);
    const stages = new Set<string>();
    const r = await transcribe(media, { kind: "openai-compatible", baseUrl: server.url, apiKey: KEY, model: "whisper-large-v3-turbo" }, { onProgress: (p) => stages.add(p.stage) });
    expect(r).toEqual({ segments: [{ startMs: 0, endMs: 1000, text: "ok" }], engine: "openai-compatible:whisper-large-v3-turbo", language: "en", gaps: [] });
    expect([...stages]).toEqual(["extract", "transcribe"]);
  });
});

describe("deepgram", () => {
  it("posts the raw WAV with a Token header and maps utterances", async () => {
    server = await fakeServer((_req, res) =>
      json(res, {
        results: {
          channels: [{ detected_language: "en", alternatives: [{ transcript: "x" }] }],
          utterances: [
            { start: 0.25, end: 1.5, transcript: "Hello there." },
            { start: 2, end: 2.75, transcript: "Bye." },
          ],
        },
      }),
    );
    const input = await audioInput(3);
    const r = await transcribeDeepgram(input, { apiKey: KEY, baseUrl: server.url });
    expect(r.segments).toEqual([
      { startMs: 250, endMs: 1500, text: "Hello there." },
      { startMs: 2000, endMs: 2750, text: "Bye." },
    ]);
    expect(r.language).toBe("en");
    expect(r.engine).toBe("deepgram:nova-3");
    const [req] = server.requests;
    const url = new URL(req.url, "http://x");
    expect(url.pathname).toBe("/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ model: "nova-3", utterances: "true", detect_language: "true", smart_format: "true" });
    expect(req.headers.authorization).toBe(`Token ${KEY}`);
    expect(req.headers["content-type"]).toBe("audio/wav");
    expect(req.body.subarray(0, 4).toString()).toBe("RIFF");
    expect(req.body.length).toBe(44 + 3 * 32000);
  });

  it("falls back to words when there are no utterances", async () => {
    server = await fakeServer((_req, res) =>
      json(res, {
        results: {
          channels: [
            {
              alternatives: [
                {
                  words: [
                    { word: "hi", punctuated_word: "Hi", start: 0, end: 0.4 },
                    { word: "you", punctuated_word: "you.", start: 0.4, end: 0.8 },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const r = await transcribeDeepgram(await audioInput(1), { apiKey: KEY, baseUrl: server.url, model: "nova-2" });
    expect(r.segments).toEqual([{ startMs: 0, endMs: 800, text: "Hi you." }]);
    expect(r.engine).toBe("deepgram:nova-2");
  });

  it("reports HTTP errors safely", async () => {
    server = await fakeServer((_req, res) => json(res, { err_msg: SECRET_TEXT }, 402));
    await expectSafeError(transcribeDeepgram(await audioInput(1), { apiKey: KEY, baseUrl: server.url }), "deepgram", 402);
  });
});

describe("assemblyai", () => {
  it("uploads, starts a job, polls, and groups words (ms) into segments", async () => {
    let polls = 0;
    server = await fakeServer((req, res) => {
      if (req.url === "/v2/upload") return json(res, { upload_url: "https://cdn.example/upload/abc" });
      if (req.url === "/v2/transcript" && req.method === "POST") return json(res, { id: "t1", status: "queued" });
      if (req.url === "/v2/transcript/t1") {
        polls++;
        if (polls < 2) return json(res, { id: "t1", status: "processing" });
        return json(res, {
          id: "t1",
          status: "completed",
          language_code: "en_us",
          words: [
            { text: "One", start: 100, end: 400 },
            { text: "two.", start: 400, end: 3500 },
            { text: "Three", start: 5000, end: 5400 },
          ],
        });
      }
      json(res, {}, 404);
    });
    const input = await audioInput(6);
    const r = await transcribeAssemblyAI(input, { apiKey: KEY, baseUrl: server.url }, { pollIntervalMs: 5 });
    expect(r.segments).toEqual([
      { startMs: 100, endMs: 3500, text: "One two." },
      { startMs: 5000, endMs: 5400, text: "Three" },
    ]);
    expect(r.language).toBe("en_us");
    expect(r.engine).toBe("assemblyai");
    const [upload, create] = server.requests;
    expect(upload.headers.authorization).toBe(KEY);
    expect(upload.headers["content-type"]).toBe("application/octet-stream");
    expect(upload.body.length).toBe(44 + 6 * 32000);
    expect(create.headers.authorization).toBe(KEY);
    expect(JSON.parse(create.body.toString())).toEqual({ audio_url: "https://cdn.example/upload/abc", language_detection: true });
    expect(polls).toBe(2);
  });

  it("passes the model as speech_models and prefers utterances", async () => {
    server = await fakeServer((req, res) => {
      if (req.url === "/v2/upload") return json(res, { upload_url: "u" });
      if (req.method === "POST") return json(res, { id: "t2", status: "completed", utterances: [{ text: "Hi.", start: 0, end: 900 }] });
      json(res, {}, 404);
    });
    const r = await transcribeAssemblyAI(await audioInput(1), { apiKey: KEY, baseUrl: server.url, model: "universal" }, { pollIntervalMs: 5 });
    expect(JSON.parse(server.requests[1].body.toString()).speech_models).toEqual(["universal"]);
    expect(r.segments).toEqual([{ startMs: 0, endMs: 900, text: "Hi." }]);
    expect(r.engine).toBe("assemblyai:universal");
  });

  it("fails cleanly when the job errors, without the provider's message", async () => {
    server = await fakeServer((req, res) => {
      if (req.url === "/v2/upload") return json(res, { upload_url: "u" });
      return json(res, { id: "t3", status: "error", error: SECRET_TEXT });
    });
    const err = await transcribeAssemblyAI(await audioInput(1), { apiKey: KEY, baseUrl: server.url }, { pollIntervalMs: 5 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/assemblyai/);
    expect((err as Error).message).not.toContain(SECRET_TEXT);
  });

  it("reports HTTP errors safely", async () => {
    server = await fakeServer((_req, res) => json(res, { error: SECRET_TEXT }, 401));
    await expectSafeError(transcribeAssemblyAI(await audioInput(1), { apiKey: KEY, baseUrl: server.url }), "assemblyai", 401);
  });
});

describe("elevenlabs", () => {
  it("posts multipart with xi-api-key and groups words, skipping spacing", async () => {
    server = await fakeServer((_req, res) =>
      json(res, {
        language_code: "eng",
        text: "Good morning. Again",
        words: [
          { text: "Good", start: 0.1, end: 0.4, type: "word" },
          { text: " ", start: 0.4, end: 0.45, type: "spacing" },
          { text: "morning.", start: 0.45, end: 3.2, type: "word" },
          { text: "(laughs)", start: 3.3, end: 3.6, type: "audio_event" },
          { text: "Again", start: 5, end: 5.5, type: "word" },
        ],
      }),
    );
    const r = await transcribeElevenLabs(await audioInput(6), { apiKey: KEY, baseUrl: server.url });
    expect(r.segments).toEqual([
      { startMs: 100, endMs: 3200, text: "Good morning." },
      { startMs: 5000, endMs: 5500, text: "Again" },
    ]);
    expect(r.language).toBe("eng");
    expect(r.engine).toBe("elevenlabs:scribe_v2");
    const [req] = server.requests;
    expect(req.url).toBe("/v1/speech-to-text");
    expect(req.headers["xi-api-key"]).toBe(KEY);
    expect(req.headers.authorization).toBeUndefined();
    const form = await formData(req);
    expect(form.get("model_id")).toBe("scribe_v2");
    expect((form.get("file") as File).size).toBe(44 + 6 * 32000);
  });

  it("reports HTTP errors safely", async () => {
    server = await fakeServer((_req, res) => json(res, { detail: SECRET_TEXT }, 422));
    await expectSafeError(transcribeElevenLabs(await audioInput(1), { apiKey: KEY, baseUrl: server.url }), "elevenlabs", 422);
  });

  it("reports HTTP 404 errors without the key or body", async () => {
    server = await fakeServer((_req, res) => json(res, { detail: SECRET_TEXT }, 404));
    const err = await expectSafeError(
      transcribeElevenLabs(await audioInput(1), { apiKey: KEY, baseUrl: server.url }),
      "elevenlabs",
      404,
    );
    expect(err.message).toContain("endpoint or model not found; check the base URL and model name");
  });
});

describe("gemini", () => {
  function reply(obj: unknown) {
    return { candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } }] };
  }

  it("sends the audio inline with a JSON schema and validates the answer", async () => {
    server = await fakeServer((_req, res) =>
      json(res, reply({ language: "de", segments: [{ start: 0.5, end: 2, text: "Guten Tag." }, { start: "00:03", end: "0:04.5", text: "Wie geht's?" }] })),
    );
    const r = await transcribeGemini(await audioInput(5), { apiKey: KEY, baseUrl: server.url });
    expect(r.segments).toEqual([
      { startMs: 500, endMs: 2000, text: "Guten Tag." },
      { startMs: 3000, endMs: 4500, text: "Wie geht's?" },
    ]);
    expect(r.language).toBe("de");
    expect(r.engine).toBe("gemini:gemini-3.5-flash-lite");
    const [req] = server.requests;
    expect(req.url).toBe("/models/gemini-3.5-flash-lite:generateContent");
    expect(req.headers["x-goog-api-key"]).toBe(KEY);
    expect(req.url).not.toContain(KEY);
    const body = JSON.parse(req.body.toString());
    const audio = body.contents[0].parts[0].inline_data;
    expect(audio.mime_type).toBe("audio/wav");
    expect(Buffer.from(audio.data, "base64").length).toBe(44 + 5 * 32000);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.required).toEqual(["segments"]);
  });

  it("chunks long audio, offsets each piece and clamps times to the piece", async () => {
    let n = 0;
    server = await fakeServer((_req, res) => {
      n++;
      json(res, reply("```json\n" + JSON.stringify({ segments: [{ start: 1, end: 99, text: `part ${n}` }] }) + "\n```"));
    });
    const input = await audioInput(20, [{ startSec: 9, endSec: 11 }]);
    const r = await transcribeGemini(input, { apiKey: KEY, baseUrl: server.url, model: "gemini-x" }, { maxSec: 12, targetSec: 10 });
    expect(n).toBe(2);
    expect(r.segments).toEqual([
      { startMs: 1000, endMs: 10000, text: "part 1" },
      { startMs: 11000, endMs: 20000, text: "part 2" },
    ]);
  });

  it("rejects an answer that is not the transcript format", async () => {
    server = await fakeServer((_req, res) => json(res, reply({ words: [SECRET_TEXT] })));
    const err = await transcribeGemini(await audioInput(1), { apiKey: KEY, baseUrl: server.url }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/gemini.*did not match/);
    expect((err as Error).message).not.toContain(SECRET_TEXT);
  });

  it("reports HTTP errors safely", async () => {
    server = await fakeServer((_req, res) => json(res, { error: { message: SECRET_TEXT } }, 400));
    await expectSafeError(transcribeGemini(await audioInput(1), { apiKey: KEY, baseUrl: server.url }), "gemini", 400);
  });
});

describe("network failures", () => {
  it("names the provider when it cannot be reached", async () => {
    const closed = await fakeServer(() => undefined);
    await closed.close();
    const err = await transcribeDeepgram(await audioInput(1), { apiKey: KEY, baseUrl: closed.url }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/^deepgram transcription failed: network error/);
  });

  it("stops when cancelled", async () => {
    server = await fakeServer(() => new Promise(() => undefined));
    const ac = new AbortController();
    const input = { ...(await audioInput(1)), signal: ac.signal };
    const p = transcribeElevenLabs(input, { apiKey: KEY, baseUrl: server.url });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("timeouts", () => {
  it("gives up on a provider that never answers after the upload, without the key", async () => {
    server = await fakeServer(() => new Promise(() => undefined));
    const err = await requestJson(
      "deepgram",
      `${server.url}/x`,
      { method: "POST", headers: { authorization: KEY, "content-type": "application/json" }, body: "{}" },
      undefined,
      undefined,
      { idleMs: 5_000, answerWaitMs: 200 },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/^deepgram transcription failed: no answer .* after the upload/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it("waits longer than the idle limit for an answer once the upload has gone", async () => {
    server = await fakeServer(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 600));
      json(res, { ok: true });
    });
    const r = await requestJson("elevenlabs", `${server.url}/x`, { method: "POST", body: "{}" }, undefined, undefined, { idleMs: 200, answerWaitMs: 5_000 });
    expect(r).toEqual({ ok: true });
  });

  it("gives up on an answer that stalls part way", async () => {
    server = await fakeServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.write('{"text":');
    });
    await expect(requestJson("openai-compatible", `${server.url}/x`, {}, undefined, undefined, { idleMs: 200 })).rejects.toThrow(/no progress/);
  });

  it("keeps a slow upload going while it moves, and sends the body intact", async () => {
    // A server that reads 64 KB every 25 ms (about 2.6 MB/s), paced by bytes rather than by
    // chunk so every OS reads at the same rate. 16 MB is larger than the socket buffers, so
    // most of the ~6 s is upload, and a full buffer never stalls the sender for a whole idle limit.
    const slow = createServer((req, res) => {
      let bytes = 0;
      let sincePause = 0;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        sincePause += chunk.length;
        if (sincePause < 64 * 1024) return;
        sincePause = 0;
        req.pause();
        setTimeout(() => req.resume(), 25);
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ bytes, type: req.headers["content-type"], length: req.headers["content-length"] }));
      });
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    try {
      const { port } = slow.address() as AddressInfo;
      const audio = new Uint8Array(16 * 1024 * 1024).fill(3);
      const idleMs = 1500;
      const t0 = Date.now();
      const r = await requestJson<{ bytes: number; type: string; length: string }>(
        "assemblyai",
        `http://127.0.0.1:${port}/v2/upload`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: audio },
        undefined,
        undefined,
        { idleMs },
      );
      expect(Date.now() - t0).toBeGreaterThan(2 * idleMs);
      expect(r).toEqual({ bytes: audio.length, type: "application/octet-stream", length: String(audio.length) });
    } finally {
      await new Promise((r) => slow.close(r));
    }
  }, 30_000);

  it("still stops at once when the caller cancels", async () => {
    server = await fakeServer(() => new Promise(() => undefined));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(requestJson("gemini", `${server.url}/x`, {}, ac.signal, undefined, { idleMs: 10_000 })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("response safety", () => {
  it("never follows a redirect with the key", async () => {
    const other = await fakeServer((_req, res) => json(res, { text: "stolen" }));
    try {
      server = await fakeServer((_req, res) => {
        res.statusCode = 307;
        res.setHeader("location", `${other.url}/v1/speech-to-text`);
        res.end();
      });
      const err = await transcribeElevenLabs(await audioInput(1), { apiKey: KEY, baseUrl: server.url }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as Error).message).not.toContain(KEY);
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("refuses an answer over the size cap, declared or streamed", async () => {
    const big = JSON.stringify({ text: "x".repeat(4096) });
    server = await fakeServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/declared") {
        res.setHeader("content-length", String(big.length));
        res.end(big);
      } else {
        // Chunked, so only the streamed count can catch it.
        res.write(big.slice(0, 2000));
        res.end(big.slice(2000));
      }
    });
    for (const path of ["/declared", "/streamed"]) {
      const err = await requestJson("deepgram", `${server.url}${path}`, {}, undefined, 1024).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as Error).message).toMatch(/^deepgram transcription failed: the answer was larger than/);
    }
    // Under the cap the same answer parses.
    await expect(requestJson("deepgram", `${server.url}/streamed`, {}, undefined, 1024 * 1024)).resolves.toMatchObject({
      text: expect.any(String),
    });
  });
});
