import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWavInfo, wavFromPcm } from "../src/audio.js";
import { tempDir } from "./helpers.js";

const dir = tempDir();

describe("readWavInfo", () => {
  it("reads standard PCM (format 1) WAV files", async () => {
    const wavPath = join(dir, "pcm.wav");
    writeFileSync(wavPath, wavFromPcm(Buffer.alloc(3200), 16000));
    const info = await readWavInfo(wavPath);
    expect(info).toEqual({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 3200,
      durationSec: 0.1,
    });
  });

  it.each([
    ["IEEE float", 3],
    ["mu-law", 7],
    ["extensible", 0xfffe],
  ])("rejects unsupported %s WAV encoding format (%i)", async (_label, formatTag) => {
    const wavPath = join(dir, `unsupported-${formatTag}.wav`);
    const buf = wavFromPcm(Buffer.alloc(320));
    buf.writeUInt16LE(formatTag, 20);
    writeFileSync(wavPath, buf);
    await expect(readWavInfo(wavPath)).rejects.toThrow(
      new RegExp(`unsupported WAV encoding format ${formatTag} \\(only PCM format 1 is supported\\)`),
    );
  });

  it("rejects a truncated fmt chunk", async () => {
    const wavPath = join(dir, "truncated-fmt.wav");
    const buf = Buffer.alloc(24);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(16, 4);
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(8, 16);
    writeFileSync(wavPath, buf);
    await expect(readWavInfo(wavPath)).rejects.toThrow(/truncated WAV fmt chunk/);
  });
});
