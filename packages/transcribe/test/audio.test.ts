import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { classifyInputProblem, detectSilences, extractAudio, inputOpenReason, probeMedia, readWavInfo, readWavSlice, type PathState } from "../src/audio.js";
import { transcribe } from "../src/index.js";
import { fakeServer, json, tempDir } from "./helpers.js";

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

describe("input that ffmpeg cannot read", () => {
  const missing = join(dir, "missing.mp4");
  const textFile = join(dir, "note.txt");
  const folder = join(dir, "a-folder");
  beforeAll(() => {
    writeFileSync(textFile, "just some words, not media\n");
    mkdirSync(folder);
  });

  const cases = [
    ["a missing file", missing, "does not exist"],
    ["a text file", textFile, "is not a video or audio file"],
    ["a folder", folder, "is a folder"],
  ] as const;

  it.each(cases)("extractAudio names the cause for %s", async (_name, path, cause) => {
    const err = await extractAudio(path, join(dir, "never.wav")).catch((e: Error) => e);
    expect((err as Error).message).toBe(`${path} ${cause}`);
  });

  it.each(cases)("probeMedia (transcription off) names the cause for %s", async (_name, path, cause) => {
    const err = await probeMedia(path).catch((e: Error) => e);
    expect((err as Error).message).toBe(`${path} ${cause}`);
  });

  it.each(cases)("transcribe with kind none names the cause for %s", async (_name, path, cause) => {
    await expect(transcribe(path, { kind: "none" })).rejects.toThrow(`${path} ${cause}`);
  });

  it.each(cases)("transcribe with a hosted provider names the cause for %s, before any request", async (_name, path, cause) => {
    const server = await fakeServer((_req, res) => json(res, { text: "unused" }));
    try {
      const config = { kind: "openai-compatible", baseUrl: server.url, apiKey: "test-key", model: "whisper-1" } as const;
      await expect(transcribe(path, config)).rejects.toThrow(`${path} ${cause}`);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("never puts raw ffmpeg output in the message", async () => {
    for (const [, path] of cases) {
      const err = (await extractAudio(path, join(dir, "never.wav")).catch((e: Error) => e)) as Error;
      expect(err.message).not.toMatch(/Error opening|\[in#|ffmpeg version|Invalid data found|Is a directory|No such file/);
    }
  });
});

describe("inputOpenReason", () => {
  const input = "file:/tmp/missing.mp4";

  it("reads the reason from newer ffmpeg output", () => {
    const stderr = ["[in#0 @ 0x55] Error opening input: No such file or directory", `Error opening input file ${input}.`, "Error opening input files: No such file or directory"].join("\n");
    expect(inputOpenReason(stderr, input)).toBe("No such file or directory");
  });

  it("reads the reason from older ffmpeg output, which only prints '<input>: <reason>'", () => {
    expect(inputOpenReason(`${input}: Invalid data found when processing input\n`, input)).toBe("Invalid data found when processing input");
  });

  it("copes with Windows paths and CRLF line endings", () => {
    const win = "file:C:\\Users\\me\\clip (1).mp4";
    expect(inputOpenReason(`${win}: Permission denied\r\n`, win)).toBe("Permission denied");
    expect(inputOpenReason("[in#0 @ 000001] Error opening input: Permission denied\r\n", win)).toBe("Permission denied");
  });

  it("ignores failures on the output file and stray words elsewhere", () => {
    expect(inputOpenReason("[out#0/wav @ 0x1] Error opening output file /out/a.wav: Permission denied", input)).toBeNull();
    expect(inputOpenReason("[mov @ 0x1] Permission denied while reading metadata tag", input)).toBeNull();
    expect(inputOpenReason("Conversion failed!", input)).toBeNull();
  });
});

describe("classifyInputProblem", () => {
  const table: [string, PathState, string | null, ReturnType<typeof classifyInputProblem>][] = [
    ["missing path", "missing", null, "missing"],
    ["missing path wins over ffmpeg wording", "missing", "Invalid data found when processing input", "missing"],
    ["folder", "folder", "Is a directory", "folder"],
    ["Windows folder, where ffmpeg says Permission denied", "folder", "Permission denied", "folder"],
    ["unreadable path", "denied", null, "permission"],
    ["file ffmpeg cannot read", "file", "Permission denied", "permission"],
    ["text file", "file", "Invalid data found when processing input", "not-media"],
    ["file that vanished while ffmpeg ran", "file", "No such file or directory", "missing"],
    ["wording in another case", "file", "INVALID DATA FOUND WHEN PROCESSING INPUT", "not-media"],
    ["unknown reason stays generic", "file", "Protocol not found", null],
    ["no reason stays generic", "file", null, null],
    ["filesystem could not tell, ffmpeg reason is used", "unknown", "Is a directory", "folder"],
    ["filesystem could not tell, no reason", "unknown", null, null],
  ];
  it.each(table)("%s", (_name, state, reason, expected) => {
    expect(classifyInputProblem(state, reason)).toBe(expected);
  });
});
