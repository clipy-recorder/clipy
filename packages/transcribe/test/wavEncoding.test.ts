import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWavInfo, wavFromPcm } from "../src/audio.js";
import { tempDir } from "./helpers.js";

describe("readWavInfo encoding validation", () => {
  it("accepts a standard PCM WAV (format tag 1)", async () => {
    const wavPath = join(tempDir(), "pcm.wav");
    writeFileSync(wavPath, wavFromPcm(Buffer.alloc(320)));
    const info = await readWavInfo(wavPath);
    expect(info.sampleRate).toBe(16000);
    expect(info.bitsPerSample).toBe(16);
  });

  it("rejects a WAV with IEEE float encoding (format tag 3)", async () => {
    // Build a minimal PCM WAV, then patch the format tag at byte 20 from 1 to 3.
    const buf = Buffer.from(wavFromPcm(Buffer.alloc(320)));
    buf.writeUInt16LE(3, 20);
    const wavPath = join(tempDir(), "float.wav");
    writeFileSync(wavPath, buf);
    await expect(readWavInfo(wavPath)).rejects.toThrow(
      /unsupported WAV encoding.*format tag 3/,
    );
  });

  it("rejects a WAV with A-law encoding (format tag 6)", async () => {
    const buf = Buffer.from(wavFromPcm(Buffer.alloc(320)));
    buf.writeUInt16LE(6, 20);
    const wavPath = join(tempDir(), "alaw.wav");
    writeFileSync(wavPath, buf);
    await expect(readWavInfo(wavPath)).rejects.toThrow(
      /unsupported WAV encoding.*format tag 6/,
    );
  });
});