import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWavInfo, wavFromPcm } from "../src/audio.js";
import { tempDir } from "./helpers.js";

const dir = tempDir("clipy-wav-test-");
let counter = 0;

/** Write `bytes` to a fresh file in the temp folder and return its path. */
function write(bytes: Buffer): string {
  const path = join(dir, `case-${counter++}.wav`);
  writeFileSync(path, bytes);
  return path;
}

/** A RIFF chunk: 4-byte id, little-endian length, body, and a pad byte when the length is odd. */
function chunk(id: string, body: Buffer, declaredLen = body.length): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, "ascii");
  head.writeUInt32LE(declaredLen, 4);
  return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** The 16-byte body of a PCM `fmt ` chunk. */
function fmtBody(channels: number, sampleRate: number, bits: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(1, 0); // PCM
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(sampleRate, 4);
  b.writeUInt32LE((sampleRate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
}

/** RIFF/WAVE wrapper around the given chunks. */
function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
}

describe("readWavInfo", () => {
  it("reads the canonical 44-byte header written by wavFromPcm", async () => {
    const info = await readWavInfo(write(wavFromPcm(Buffer.alloc(32_000)))); // 1 s of 16 kHz mono
    expect(info).toEqual({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataOffset: 44, dataBytes: 32_000, durationSec: 1 });
  });

  it("works out the duration from the sample rate, channel count and bit depth", async () => {
    const wav = riff(chunk("fmt ", fmtBody(2, 44_100, 16)), chunk("data", Buffer.alloc(44_100 * 4 * 2))); // 2 s of stereo
    const info = await readWavInfo(write(wav));
    expect(info).toMatchObject({ sampleRate: 44_100, channels: 2, bitsPerSample: 16, dataBytes: 352_800 });
    expect(info.durationSec).toBeCloseTo(2, 10);
  });

  it("skips extra chunks such as LIST between fmt and data", async () => {
    const list = chunk("LIST", Buffer.from("INFOISFT\x0e\x00\x00\x00Lavf60.16.100\x00", "latin1"));
    const wav = riff(chunk("fmt ", fmtBody(1, 16_000, 16)), list, chunk("data", Buffer.alloc(3200)));
    const info = await readWavInfo(write(wav));
    expect(info.dataBytes).toBe(3200);
    expect(info.dataOffset).toBe(12 + 24 + list.length + 8);
    expect(info.durationSec).toBeCloseTo(0.1, 10);
  });

  it("steps over the pad byte after an odd-length chunk", async () => {
    const odd = chunk("junk", Buffer.from("abc")); // 3 bytes of body plus 1 pad byte
    const wav = riff(odd, chunk("fmt ", fmtBody(1, 16_000, 16)), chunk("data", Buffer.alloc(320)));
    const info = await readWavInfo(write(wav));
    expect(info).toMatchObject({ sampleRate: 16_000, dataBytes: 320 });
  });

  it("trusts the file size when a streamed WAV carries a placeholder data length", async () => {
    const pcm = Buffer.alloc(16_000); // 0.5 s actually on disk
    const wav = riff(chunk("fmt ", fmtBody(1, 16_000, 16)), chunk("data", pcm, 0xffff_ffff));
    const info = await readWavInfo(write(wav));
    expect(info.dataBytes).toBe(16_000);
    expect(info.durationSec).toBeCloseTo(0.5, 10);
  });

  it("clamps a data length that is longer than the file (a cut-off recording)", async () => {
    const wav = riff(chunk("fmt ", fmtBody(1, 16_000, 16)), chunk("data", Buffer.alloc(6400), 64_000));
    const info = await readWavInfo(write(wav));
    expect(info.dataBytes).toBe(6400);
    expect(info.durationSec).toBeCloseTo(0.2, 10);
  });

  it("rejects a file that is not RIFF/WAVE", async () => {
    await expect(readWavInfo(write(Buffer.from("ID3\x04 this is an mp3, not a wav, at all, honest")))).rejects.toThrow(/is not a WAV file/);
  });

  it("rejects RIFF files that are not WAVE (for example AVI)", async () => {
    const avi = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI "), Buffer.alloc(32)]);
    await expect(readWavInfo(write(avi))).rejects.toThrow(/is not a WAV file/);
  });

  it("rejects an empty file", async () => {
    await expect(readWavInfo(write(Buffer.alloc(0)))).rejects.toThrow(/is not a WAV file/);
  });

  it("rejects a header with no data chunk", async () => {
    await expect(readWavInfo(write(riff(chunk("fmt ", fmtBody(1, 16_000, 16)))))).rejects.toThrow(/no PCM data chunk/);
  });

  it("rejects a data chunk that comes before fmt", async () => {
    const wav = riff(chunk("data", Buffer.alloc(64)), chunk("fmt ", fmtBody(1, 16_000, 16)));
    await expect(readWavInfo(write(wav))).rejects.toThrow(/no PCM data chunk/);
  });

  it("rejects a fmt chunk that is cut off by the end of the file", async () => {
    const wav = riff(chunk("fmt ", fmtBody(1, 16_000, 16).subarray(0, 8), 16));
    await expect(readWavInfo(write(wav))).rejects.toThrow(/damaged WAV header/);
  });

  it("rejects a fmt chunk too short to hold the format fields", async () => {
    const wav = riff(chunk("fmt ", Buffer.alloc(4)), chunk("data", Buffer.alloc(64)));
    await expect(readWavInfo(write(wav))).rejects.toThrow(/damaged WAV header/);
  });

  it.each([
    ["zero channels", fmtBody(0, 16_000, 16)],
    ["zero sample rate", fmtBody(1, 0, 16)],
    ["zero bits per sample", fmtBody(1, 16_000, 0)],
  ])("rejects a header with %s instead of reporting a NaN duration", async (_name, fmt) => {
    const wav = riff(chunk("fmt ", fmt), chunk("data", Buffer.alloc(64)));
    await expect(readWavInfo(write(wav))).rejects.toThrow(/damaged WAV header/);
  });

  it("names the file in its errors", async () => {
    const path = write(Buffer.from("nope"));
    await expect(readWavInfo(path)).rejects.toThrow(path);
  });
});
