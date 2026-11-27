import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { detectSilences, extractAudio, readWavInfo, readWavSlice } from "../src/audio.js";
import { transcribe } from "../src/index.js";
import { tempDir } from "./helpers.js";

const dir = tempDir();
const video = join(dir, "clip.mp4");
const gappy = join(dir, "gappy.m4a");
const silentVideo = join(dir, "silent.mp4");

function ff(args: string[]) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

beforeAll(() => {
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

  it("turns a video into 16 kHz mono 16-bit WAV", async () => {
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

  it("says clearly when the file has no audio", async () => {
    await expect(extractAudio(silentVideo, join(dir, "y.wav"))).rejects.toThrow(/no audio track/);
  });

  it("can be cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(extractAudio(video, join(dir, "z.wav"), ac.signal)).rejects.toThrow(/cancelled/);
  });
});

describe("detectSilences", () => {
  it("finds the silent stretch", async () => {
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
  it("returns no segments and one gap over the file, and cleans up its temp folder", async () => {
    const prevTmp = process.env.TMPDIR;
    const scratch = tempDir();
    process.env.TMPDIR = scratch;
    const stages: string[] = [];
    let r;
    try {
      expect(tmpdir()).toBe(scratch);
      r = await transcribe(video, { kind: "none" }, { onProgress: (p) => stages.push(p.stage) });
    } finally {
      if (prevTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmp;
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

describe("an input ffmpeg cannot read", () => {
  // `none` fails while probing the length; a hosted kind fails while extracting
  // the audio, before any request (nothing listens on port 9).
  const kinds = [
    ["transcription off", { kind: "none" }],
    ["a hosted kind", { kind: "openai-compatible", baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" }],
  ] as const;

  describe.each(kinds)("with %s", (_label, config) => {
    it("says when the file does not exist", async () => {
      const missing = join(dir, "missing.mp4");
      await expect(transcribe(missing, config)).rejects.toThrow(`${missing} does not exist`);
    });

    it("says when the file is not a video or audio file", async () => {
      const text = join(dir, "notes.txt");
      writeFileSync(text, "just some text\n");
      await expect(transcribe(text, config)).rejects.toThrow(`${text} is not a video or audio file`);
    });

    // On Windows ffmpeg reports a folder as "Permission denied", not "Is a directory".
    it("says when the path is a folder", async () => {
      const folder = tempDir();
      await expect(transcribe(folder, config)).rejects.toThrow(`${folder} is a folder`);
    });

    // Windows ignores the mode bits and root reads anything, so only a POSIX user can check this.
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("says when the file cannot be opened", async () => {
      const locked = join(tempDir(), "locked.mp4");
      copyFileSync(video, locked);
      chmodSync(locked, 0o000);
      await expect(transcribe(locked, config)).rejects.toThrow(`${locked} cannot be opened: permission denied`);
    });
  });
});
