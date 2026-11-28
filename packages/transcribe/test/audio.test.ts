import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { countAudioTracks, detectSilences, extractAudio, measureMeanVolume, readWavInfo, readWavSlice } from "../src/audio.js";
import { transcribe } from "../src/index.js";
import type { AudioTrack } from "../src/types.js";
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

// `ffmpeg --version` is not an ffmpeg option, so check with -version.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasFfmpeg)("extractAudio with more than one audio track", () => {
  // A take that keeps two sounds apart: track 0 is stereo silence (the system
  // sound), track 1 a mono tone (the microphone). On its own ffmpeg picks the
  // track with the most channels, so the tone is left out.
  const twoTracks = join(dir, "two-tracks.mp4");
  const meanDb = async (track: AudioTrack | undefined, name: string) => {
    const out = join(dir, name);
    await extractAudio(twoTracks, out, undefined, track);
    // AAC silence decodes to about -91 dB rather than -inf; null means -inf.
    return (await measureMeanVolume(out)) ?? -Infinity;
  };

  beforeAll(() => {
    ff([
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
      "-map", "0:a", "-map", "1:a", "-c:a", "aac", twoTracks,
    ]);
  });

  it("counts the audio tracks", async () => {
    expect(await countAudioTracks(twoTracks)).toBe(2);
    expect(await countAudioTracks(video)).toBe(1);
    expect(await countAudioTracks(silentVideo)).toBe(0);
  });

  it("keeps ffmpeg's own pick by default, which here is the silent track", async () => {
    expect(await meanDb(undefined, "track-default.wav")).toBeLessThan(-60);
  });

  it("takes the track asked for", async () => {
    expect(await meanDb(0, "track-0.wav")).toBeLessThan(-60);
    expect(await meanDb(1, "track-1.wav")).toBeGreaterThan(-35);
  });

  it("mixes every track, so the tone is in", async () => {
    expect(await meanDb("mix", "track-mix.wav")).toBeGreaterThan(-35);
  });

  it("says clearly when the track does not exist", async () => {
    await expect(extractAudio(twoTracks, join(dir, "track-2.wav"), undefined, 2)).rejects.toThrow(
      /has 2 audio tracks, so there is no audio track 2 \(tracks are numbered from 0\)/,
    );
  });

  it("refuses a track that is not a whole number from 0", async () => {
    await expect(extractAudio(twoTracks, join(dir, "track-bad.wav"), undefined, -1)).rejects.toThrow(/whole number from 0/);
    await expect(extractAudio(twoTracks, join(dir, "track-bad.wav"), undefined, 1.5)).rejects.toThrow(/whole number from 0/);
  });

  it("still reports a file with no audio as having no audio track", async () => {
    await expect(extractAudio(silentVideo, join(dir, "track-none.wav"), undefined, "mix")).rejects.toThrow(/no audio track/);
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
