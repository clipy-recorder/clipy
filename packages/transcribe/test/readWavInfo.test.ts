import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWavInfo, wavFromPcm } from "../src/audio.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clipy-wav-info-"));
  dirs.push(dir);
  return dir;
}

function extensibleWav(subFormat: "pcm" | "float" = "pcm"): Buffer {
  const standard = wavFromPcm(Buffer.alloc(3200));
  const wav = Buffer.concat([standard.subarray(0, 36), Buffer.alloc(24), standard.subarray(36)]);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.writeUInt32LE(40, 16);
  wav.writeUInt16LE(0xfffe, 20);
  wav.writeUInt16LE(22, 36); // WAVEFORMATEXTENSIBLE extension size.
  wav.set(
    [subFormat === "pcm" ? 1 : 3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113],
    44,
  );
  return wav;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readWavInfo", () => {
  it("rejects invalid and truncated WAV headers", async () => {
    const path = join(tempDir(), "invalid.wav");
    writeFileSync(path, Buffer.from("RIFF"));
    await expect(readWavInfo(path)).rejects.toThrow(/not a WAV file/i);
    writeFileSync(path, Buffer.from("NOPE0000WAVE"));
    await expect(readWavInfo(path)).rejects.toThrow(/not a WAV file/i);
  });

  it("reads supported PCM WAV files", async () => {
    const path = join(tempDir(), "pcm.wav");
    writeFileSync(path, wavFromPcm(Buffer.alloc(3200)));
    await expect(readWavInfo(path)).resolves.toMatchObject({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataBytes: 3200,
      durationSec: 0.1,
    });
  });

  it("continues to read extensible WAV files with the PCM subformat", async () => {
    const path = join(tempDir(), "extensible-pcm.wav");
    writeFileSync(path, extensibleWav());
    await expect(readWavInfo(path)).resolves.toMatchObject({ sampleRate: 16000, bitsPerSample: 16, dataBytes: 3200 });
  });

  it.each([3, 0xffff])("rejects unsupported encoding tag %i with a descriptive error", async (format) => {
    const wav = wavFromPcm(Buffer.alloc(32));
    wav.writeUInt16LE(format, 20); // IEEE float and unknown tags are not integer PCM.
    const path = join(tempDir(), `unsupported-format-${format}.wav`);
    writeFileSync(path, wav);
    await expect(readWavInfo(path)).rejects.toThrow(new RegExp(`unsupported WAV encoding format ${format}.*only PCM`, "i"));
  });

  it("rejects an extensible WAV whose subformat is not PCM", async () => {
    const path = join(tempDir(), "extensible-float.wav");
    writeFileSync(path, extensibleWav("float"));
    await expect(readWavInfo(path)).rejects.toThrow(/unsupported WAV encoding format 65534.*only PCM/i);
  });

  it("rejects incomplete and missing format information safely", async () => {
    const truncated = join(tempDir(), "truncated-format.wav");
    const full = wavFromPcm(Buffer.alloc(32));
    full.writeUInt32LE(12, 16); // `fmt ` declares fewer than the required 16 bytes.
    writeFileSync(truncated, full);
    await expect(readWavInfo(truncated)).rejects.toThrow(/incomplete WAV format chunk/i);

    full.writeUInt32LE(0xffff_ffff, 16); // The declared format chunk extends past the end of the file.
    writeFileSync(truncated, full);
    await expect(readWavInfo(truncated)).rejects.toThrow(/incomplete WAV format chunk/i);

    const noFormat = join(tempDir(), "missing-format.wav");
    const header = Buffer.alloc(20);
    header.write("RIFF", 0, "ascii");
    header.write("WAVE", 8, "ascii");
    header.write("data", 12, "ascii");
    header.writeUInt32LE(0, 16);
    writeFileSync(noFormat, header);
    await expect(readWavInfo(noFormat)).rejects.toThrow(/no PCM data chunk/i);
  });

  it.each([22, 24, 34])("rejects zero format information at byte offset %i", async (offset) => {
    const wav = wavFromPcm(Buffer.alloc(32));
    if (offset === 24) wav.writeUInt32LE(0, offset);
    else wav.writeUInt16LE(0, offset);
    const path = join(tempDir(), `zero-format-${offset}.wav`);
    writeFileSync(path, wav);
    await expect(readWavInfo(path)).rejects.toThrow(/invalid WAV format information/i);
  });
});
