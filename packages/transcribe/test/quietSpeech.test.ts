/**
 * Quiet speech must never vanish: thresholds follow the recording's loudness,
 * a recording that is one piece is always sent, and a piece that is skipped
 * for having no speech is reported as a gap. Also: a file with no audio track
 * is a gap, not an error, and file names with a colon are read as files.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAudio, ffmpegInput, readWavInfo, silenceThresholds } from "../src/audio.js";
import { transcribe } from "../src/index.js";
import { trimPieceToSpeech } from "../src/local.js";
import { audioInputFor, piecesWithoutSpeech, type AudioInput } from "../src/providers/common.js";
import { planChunks } from "../src/chunking.js";
import { transcribeOpenAICompatible } from "../src/providers/openai.js";
import { ffmpeg, hasFfmpeg, fakeServer, formData, json, tempDir, wavSeconds, type FakeServer } from "./helpers.js";

function ff(args: string[]) {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

let server: FakeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("silenceThresholds", () => {
  it("keeps -30 dB for speech at a normal level and follows quiet recordings down", () => {
    // A typical mic take averages about -25 dB; macOS `say` about -18.6 dB.
    expect(silenceThresholds(-25)).toEqual({ splitDb: -30, skipDb: -55, quiet: false });
    expect(silenceThresholds(-18.6)).toEqual({ splitDb: -30, skipDb: -50, quiet: false });
    expect(silenceThresholds(-34.9).splitDb).toBe(-30);
    const quiet = silenceThresholds(-47.4); // speech peaking near -31 dBFS
    expect(quiet.quiet).toBe(true);
    expect(quiet.splitDb).toBeCloseTo(-59.4);
    expect(quiet.skipDb).toBeCloseTo(-77.4);
    expect(silenceThresholds(-91)).toEqual({ splitDb: -70, skipDb: -80, quiet: true });
    expect(silenceThresholds(null)).toEqual({ splitDb: -30, skipDb: -50, quiet: false });
  });
});

describe("quiet speech", () => {
  it.runIf(hasFfmpeg)("sends every piece holding quiet speech and reports the silent piece as a gap", async () => {
    const dir = tempDir();
    const wav = join(dir, "quiet.wav");
    // A tone peaking near -45 dBFS for 8 s, 10 s of silence, the tone again for 7 s.
    ff([
      "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=16000:duration=8,volume=-27dB",
      "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=10",
      "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=16000:duration=7,volume=-27dB",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav,
    ]);
    const seen: number[] = [];
    server = await fakeServer(async (req, res) => {
      const file = (await formData(req)).get("file") as File;
      seen.push(wavSeconds(Buffer.from(await file.arrayBuffer())));
      json(res, { segments: [{ start: 0.5, end: 1.5, text: `piece ${seen.length}` }] });
    });
    const input = audioInputFor(wav, await readWavInfo(wav));
    const r = await transcribeOpenAICompatible(input, { baseUrl: server.url, apiKey: "k", model: "m" }, { maxUploadBytes: 44 + 10 * 32000 });
    // At -30 dB the whole file read as silence and nothing was sent.
    expect(seen.length).toBe(3);
    expect(r.segments.map((s) => s.text)).toEqual(["piece 1", "piece 2", "piece 3"]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].reason).toBe("no speech detected");
    expect(r.gaps[0].startMs).toBeGreaterThanOrEqual(7500);
    expect(r.gaps[0].endMs).toBeLessThanOrEqual(18500);
  });

  it.runIf(hasFfmpeg)("always sends a recording that is one piece, even a silent one", async () => {
    const dir = tempDir();
    const wav = join(dir, "silent.wav");
    ff(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=3", "-c:a", "pcm_s16le", wav]);
    server = await fakeServer((_req, res) => json(res, { segments: [] }));
    const r = await transcribeOpenAICompatible(audioInputFor(wav, await readWavInfo(wav)), { baseUrl: server.url, apiKey: "k", model: "m" });
    expect(server.requests).toHaveLength(1);
    expect(r.gaps).toEqual([]);
  });
});

describe("a file with no audio track", () => {
  it.runIf(hasFfmpeg)("is one gap over the file for every kind, not an error", async () => {
    const dir = tempDir();
    const video = join(dir, "video-only.mp4");
    ff(["-f", "lavfi", "-i", "color=c=red:s=64x64:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const off = await transcribe(video, { kind: "none" });
    expect(off.gaps).toHaveLength(1);
    expect(off.gaps[0]).toMatchObject({ startMs: 0, reason: "transcription off" });
    expect(off.gaps[0].endMs).toBeGreaterThan(1900);
    // Never reaches the engine: no model and no server are needed.
    for (const config of [
      { kind: "local", model: "english-fast" },
      { kind: "openai-compatible", baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" },
    ] as const) {
      const r = await transcribe(video, config, { modelDir: tempDir() });
      expect(r.segments).toEqual([]);
      expect(r.gaps).toHaveLength(1);
      expect(r.gaps[0]).toMatchObject({ startMs: 0, reason: "no audio track" });
      expect(r.gaps[0].endMs).toBeGreaterThan(1900);
    }
  });
});

describe("file names with a colon", () => {
  it.runIf(hasFfmpeg)("are read as local files, not as an ffmpeg protocol", async () => {
    const dir = tempDir();
    const prev = process.cwd();
    process.chdir(dir);
    try {
      ff(["-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", "file:take2:final.m4a"]);
      expect(ffmpegInput("take2:final.m4a")).toBe(`file:${join(process.cwd(), "take2:final.m4a")}`);
      await extractAudio("take2:final.m4a", "out:1.wav");
      expect((await readWavInfo(join(dir, "out:1.wav"))).durationSec).toBeGreaterThan(0.9);
    } finally {
      process.chdir(prev);
    }
  });
});

describe("trimPieceToSpeech", () => {
  it("cuts dead silence off both ends of a piece's audio and keeps its core", () => {
    const p = { index: 1, extractStartSec: 127.5, extractDurSec: 135, keepStartSec: 130, keepEndSec: 260, hardCut: false };
    const t = trimPieceToSpeech(p, [
      { startSec: 100, endSec: 200 },
      { startSec: 250, endSec: 400 },
    ]);
    expect(t).toEqual({ ...p, extractStartSec: 199.5, extractDurSec: 51 });
    // No silence at the edges, or nothing but silence: unchanged.
    expect(trimPieceToSpeech(p, [])).toEqual(p);
    expect(trimPieceToSpeech(p, [{ startSec: 0, endSec: 500 }])).toBe(p);
  });
});

describe("pieces of background noise", () => {
  it.runIf(hasFfmpeg)("are not sent to engines that invent words in noise, in a recording at a normal level", async () => {
    const dir = tempDir();
    const wav = join(dir, "noise.wav");
    // A tone at a normal level for 8 s, 10 s of fan-like noise near -42 dB, the tone again for 7 s.
    ff([
      "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=16000:duration=8",
      "-f", "lavfi", "-i", "anoisesrc=r=16000:color=pink:amplitude=0.008:d=10",
      "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=16000:duration=7",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav,
    ]);
    server = await fakeServer((_req, res) => json(res, { segments: [{ start: 0.5, end: 1.5, text: "words" }] }));
    const input = audioInputFor(wav, await readWavInfo(wav));
    expect(await input.quiet?.()).toBe(false);
    const r = await transcribeOpenAICompatible(input, { baseUrl: server.url, apiKey: "k", model: "m" }, { maxUploadBytes: 44 + 10 * 32000 });
    expect(server.requests).toHaveLength(3);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].reason).toBe("no speech detected");
  });

  it("are skipped by the ordinary silences only for those engines, and never in a quiet recording", async () => {
    const plan = planChunks([], 300, { targetSec: 100, maxSec: 100, overlapSec: 0, minSec: 15 });
    // 100-200 s is silent to the ordinary threshold (noise) but not to the strict one.
    const base = { wavPath: "", info: { sampleRate: 16000, channels: 1, bitsPerSample: 16, dataOffset: 44, dataBytes: 0, durationSec: 300 } };
    const input = (quiet: boolean): AudioInput => ({
      ...base,
      silences: async () => [{ startSec: 100, endSec: 200 }],
      noSpeech: async () => [],
      quiet: async () => quiet,
    });
    expect([...(await piecesWithoutSpeech(input(false), plan, "invents"))]).toEqual([1]);
    expect([...(await piecesWithoutSpeech(input(false), plan, "strict"))]).toEqual([]);
    expect([...(await piecesWithoutSpeech(input(true), plan, "invents"))]).toEqual([]);
  });
});
