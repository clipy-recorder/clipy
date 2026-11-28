import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { detectSilences, extractAudio, readWavInfo, readWavSlice } from "../src/audio.js";
import { transcribe } from "../src/index.js";
import { tempDir } from "./helpers.js";

/** True when ffmpeg is available on PATH. Tests that call ff() are skipped when it is not. */
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const dir = tempDir();
const video = join(dir, "clip.mp4");
const gappy = join(dir, "gappy.m4a");
const silentVideo = join(dir, "silent.mp4");

function ff(args: string[]) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

beforeAll(() => {
  // Skip fixture creation when ffmpeg is not on PATH; all tests that need
  // these files are guarded with it.skipIf(!hasFfmpeg) below.
  if (!hasFfmpeg) return;
  // 3 s of 48 kHz stereo tone with a small video track.
  ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=3", "-ac", "2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
  // tone 2 s, silence 2 s, tone 2 s
  ff([
    "-f", "lavfi", "-i", "sine=frequency=300:duration=2",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=2",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=2",
    "-filter_complex", "[0:a]aresample=44100[a];[2:a]aresample=44100[c];[a][1:a][c]concat=n=3:v=0:a=1",
    "-c:a", "aac", gappy,
  ]);
  ff(["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", silentVideo]);
});

describe("extractAudio", () => {
  const prev = process.env.CLIPY_FFMPEG;
  afterEach(() => {
    if (prev === undefined) delete process.env.CLIPY_FFMPEG;
    else process.env.CLIPY_FFMPEG = prev;
  });

  it.skipIf(!hasFfmpeg)("turns a video into 16 kHz mono 16-bit WAV", async () => {
    const out = join(dir, "clip.wav");
    await extractAudio(video, out);
    const info = await readWavInfo(out);
    expect(info).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(info.durationSec).toBeGreaterThan(2.9);
    expect(info.durationSec).toBeLessThan(3.2);
    const slice = await readWavSlice(out, info, 1, 0.5);
    expect(slice.readUInt32LE(40)).toBe(16000);
  });

  it("says clearly when ffmpeg is missing", async () => {
    process.env.CLIPY_FFMPEG = "/nonexistent/ffmpeg";
    await expect(extractAudio(video, join(dir, "x.wav"))).rejects.toThrow(/ffmpeg was not found/);
  });

  it.skipIf(!hasFfmpeg)("says clearly when the file has no audio", async () => {
    await expect(extractAudio(silentVideo, join(dir, "y.wav"))).rejects.toThrow(/no audio track/);
  });

  it("can be cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(extractAudio(video, join(dir, "z.wav"), ac.signal)).rejects.toThrow(/cancelled/);
  });
});

describe("detectSilences", () => {
  it.skipIf(!hasFfmpeg)("finds the silent stretch", async () => {
    const wav = join(dir, "gappy.wav");
    await extractAudio(gappy, wav);
    const spans = await detectSilences(wav);
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const mid = spans.find((s) => s.startSec > 1.5 && s.endSec < 4.5);
    expect(mid).toBeDefined();
    expect(mid!.endSec - mid!.startSec).toBeGreaterThan(1.5);
  });
});

describe("transcribe with transcription off", () => {
  it.skipIf(!hasFfmpeg)("returns no segments and one gap over the file, and cleans up its temp folder", async () => {
    // On Windows os.tmpdir() reads TEMP/TMP, not TMPDIR. Set all three so the
    // test works on every platform without touching platform-detection logic.
    const prevTmpdir = process.env.TMPDIR;
    const prevTemp   = process.env.TEMP;
    const prevTmp    = process.env.TMP;
    const scratch = tempDir();
    process.env.TMPDIR = scratch;
    process.env.TEMP   = scratch;
    process.env.TMP    = scratch;
    const stages: string[] = [];
    let r;
    try {
      expect(tmpdir()).toBe(scratch);
      r = await transcribe(video, { kind: "none" }, { onProgress: (p) => stages.push(p.stage) });
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmpdir;
      if (prevTemp   === undefined) delete process.env.TEMP;   else process.env.TEMP   = prevTemp;
      if (prevTmp    === undefined) delete process.env.TMP;    else process.env.TMP    = prevTmp;
    }
    expect(r.segments).toEqual([]);
    expect(r.engine).toBe("none");
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ startMs: 0, reason: "transcription off" });
    expect(r.gaps[0].endMs).toBeGreaterThan(2900);
    expect(stages).toContain("extract");
    expect(readdirSync(scratch)).toEqual([]);
  });
});
