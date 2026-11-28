/**
 * Tests for `readWavInfo` WAV audio format tag validation.
 *
 * These tests use only in-memory WAV buffers; no FFmpeg or external tools are
 * required, so they run on every OS and in every CI environment.
 *
 * Covers issue: https://github.com/clipy-recorder/clipy/issues/127
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWavInfo,
  UnsupportedWavFormatError,
  WAV_FORMAT_PCM,
  wavFromPcm,
} from "../src/audio.js";
import { tempDir } from "./helpers.js";

const dir = tempDir();

/**
 * Build a minimal in-memory WAV buffer with a custom `audioFormat` tag at
 * bytes 20–21 of the fmt chunk — the field that `readWavInfo` now validates.
 */
function makeWavWithFormatTag(audioFormat: number): Buffer {
  const pcm = Buffer.alloc(16); // 8 samples of silence
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(audioFormat, 20); // audio format tag ← field under test
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24); // 16 kHz sample rate
  header.writeUInt32LE(32000, 28); // byte rate = 16000 * 1 * 2
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe("readWavInfo — WAV format tag validation", () => {
  it("WAV_FORMAT_PCM constant is 0x0001", () => {
    expect(WAV_FORMAT_PCM).toBe(0x0001);
  });

  it("accepts standard PCM WAV files (format tag 0x0001)", async () => {
    const path = join(dir, "pcm.wav");
    await writeFile(path, makeWavWithFormatTag(WAV_FORMAT_PCM));
    const info = await readWavInfo(path);
    expect(info).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(info.durationSec).toBeGreaterThan(0);
  });

  it("rejects IEEE-float WAV (format tag 0x0003) with UnsupportedWavFormatError", async () => {
    const path = join(dir, "float.wav");
    await writeFile(path, makeWavWithFormatTag(0x0003));
    await expect(readWavInfo(path)).rejects.toThrow(UnsupportedWavFormatError);
    await expect(readWavInfo(path)).rejects.toThrow(/0x0003/);
  });

  it("rejects A-law WAV (format tag 0x0006) with a clear message", async () => {
    const path = join(dir, "alaw.wav");
    await writeFile(path, makeWavWithFormatTag(0x0006));
    await expect(readWavInfo(path)).rejects.toThrow(UnsupportedWavFormatError);
    await expect(readWavInfo(path)).rejects.toThrow(/unsupported WAV encoding/i);
    await expect(readWavInfo(path)).rejects.toThrow(/0x0006/);
  });

  it("rejects µ-law WAV (format tag 0x0007) with a clear message", async () => {
    const path = join(dir, "ulaw.wav");
    await writeFile(path, makeWavWithFormatTag(0x0007));
    await expect(readWavInfo(path)).rejects.toThrow(UnsupportedWavFormatError);
    await expect(readWavInfo(path)).rejects.toThrow(/0x0007/);
  });

  it("rejects extensible WAV (format tag 0xFFFE) with a clear message", async () => {
    const path = join(dir, "extensible.wav");
    await writeFile(path, makeWavWithFormatTag(0xfffe));
    await expect(readWavInfo(path)).rejects.toThrow(UnsupportedWavFormatError);
    await expect(readWavInfo(path)).rejects.toThrow(/0xfffe/);
  });

  it("UnsupportedWavFormatError carries the correct .name and format tag in its message", async () => {
    const path = join(dir, "float2.wav");
    await writeFile(path, makeWavWithFormatTag(0x0003));
    const err = await readWavInfo(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedWavFormatError);
    expect((err as UnsupportedWavFormatError).name).toBe("UnsupportedWavFormatError");
    expect((err as UnsupportedWavFormatError).message).toContain("0x0003");
  });

  it("UnsupportedWavFormatError message names the file path", async () => {
    const path = join(dir, "float3.wav");
    await writeFile(path, makeWavWithFormatTag(0x0003));
    const err = await readWavInfo(path).catch((e: unknown) => e);
    expect((err as UnsupportedWavFormatError).message).toContain(path);
  });

  it("wavFromPcm always produces a PCM-tagged WAV readable by readWavInfo", async () => {
    const path = join(dir, "from-pcm.wav");
    await writeFile(path, wavFromPcm(Buffer.alloc(32)));
    const info = await readWavInfo(path);
    expect(info.sampleRate).toBe(16000);
  });
});
