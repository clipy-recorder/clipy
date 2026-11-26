import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWavInfo, readWavSlice, wavFromPcm } from "../src/audio.js";
import { tempDir } from "./helpers.js";

const dir = tempDir();

/**
 * Generate a synthetic 16-bit mono PCM buffer with a predictable pattern.
 * Each 16-bit sample is 2 bytes (little-endian signed integer).
 */
function createPcm(sampleCount: number): Buffer {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    pcm.writeInt16LE((i % 1000) - 500, i * 2);
  }
  return pcm;
}

/**
 * Write a WAV buffer to a file in the test temporary directory.
 */
function writeWav(dir: string, filename: string, buf: Buffer): string {
  const filePath = join(dir, filename);
  writeFileSync(filePath, buf);
  return filePath;
}

describe("WAV helpers", () => {
  it("plain file: readWavInfo returns correct metadata for a known PCM buffer", async () => {
    const sampleRate = 16_000;
    const sampleCount = 8_000; // 0.5 seconds at 16 kHz
    const pcm = createPcm(sampleCount);
    const wavBuf = wavFromPcm(pcm, sampleRate);
    const filePath = writeWav(dir, "plain.wav", wavBuf);

    const info = await readWavInfo(filePath);

    expect(info.sampleRate).toBe(sampleRate);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.dataOffset).toBe(44);
    expect(info.dataBytes).toBe(pcm.length);
    expect(info.durationSec).toBe(0.5);
  });

  it("handles odd-length LIST chunk before 'fmt ' chunk", async () => {
    const pcm = createPcm(8_000);
    const baseWav = wavFromPcm(pcm, 16_000);

    // Split base WAV into 12-byte RIFF/WAVE header and remainder (fmt + data + PCM)
    const riffHeader = baseWav.subarray(0, 12);
    const rest = baseWav.subarray(12);

    // Build LIST chunk: 4-byte ID + 4-byte length (5) + 5-byte body + 1-byte pad
    const listHeader = Buffer.alloc(8);
    listHeader.write("LIST", 0, "ascii");
    listHeader.writeUInt32LE(5, 4);
    const listBody = Buffer.from("12345", "ascii"); // 5 bytes body (odd length)
    const listPad = Buffer.alloc(1); // 1 byte padding for 2-byte word alignment

    // Total inserted LIST chunk size is 8 + 5 + 1 = 14 bytes
    const listChunk = Buffer.concat([listHeader, listBody, listPad]);
    const wavWithList = Buffer.concat([riffHeader, listChunk, rest]);

    // Update RIFF total size field at offset 4
    wavWithList.writeUInt32LE(wavWithList.length - 8, 4);

    const filePath = writeWav(dir, "list-chunk.wav", wavWithList);
    const info = await readWavInfo(filePath);

    // Header found despite the LIST chunk; dataOffset is shifted by chunk size (44 + 14 = 58)
    expect(info.sampleRate).toBe(16_000);
    expect(info.channels).toBe(1);
    expect(info.bitsPerSample).toBe(16);
    expect(info.dataOffset).toBe(44 + listChunk.length);
    expect(info.dataBytes).toBe(pcm.length);
    expect(info.durationSec).toBe(pcm.length / 32_000);
  });

  it("data length 0xFFFFFFFF: file size wins so dataBytes equals real PCM bytes", async () => {
    const pcm = createPcm(8_000); // 16,000 bytes
    const buf = wavFromPcm(pcm, 16_000);
    // Overwrite the data chunk length field at offset 40 with 0xFFFFFFFF
    buf.writeUInt32LE(0xffffffff, 40);

    const filePath = writeWav(dir, "max-len.wav", buf);
    const info = await readWavInfo(filePath);

    expect(info.dataBytes).toBe(pcm.length);
    expect(info.durationSec).toBe(pcm.length / 32_000);
  });

  it("non-RIFF file: throws an error saying it is not a WAV file", async () => {
    const pcm = createPcm(1_000);
    const buf = wavFromPcm(pcm, 16_000);
    // Corrupt the first four bytes from 'RIFF' to 'FAKE'
    buf.write("FAKE", 0, "ascii");

    const filePath = writeWav(dir, "non-riff.wav", buf);
    await expect(readWavInfo(filePath)).rejects.toThrow(/is not a WAV file/);
  });

  it("'data' chunk before 'fmt ' chunk: throws 'has no PCM data chunk'", async () => {
    const pcm = createPcm(1_000);
    const baseWav = wavFromPcm(pcm, 16_000);

    // A standard WAV starts with 12 bytes RIFF, 24 bytes 'fmt ', then 'data' chunk
    const riffHeader = baseWav.subarray(0, 12);
    const fmtChunk = baseWav.subarray(12, 36);
    const dataChunk = baseWav.subarray(36);

    // Swap 'data' chunk before 'fmt ' chunk
    const swappedWav = Buffer.concat([riffHeader, dataChunk, fmtChunk]);
    const filePath = writeWav(dir, "data-before-fmt.wav", swappedWav);

    await expect(readWavInfo(filePath)).rejects.toThrow(/has no PCM data chunk/);
  });

  it("data length field = 0: asserts dataBytes 0 and durationSec 0", async () => {
    const pcm = createPcm(8_000);
    const buf = wavFromPcm(pcm, 16_000);
    // Set data chunk length field (offset 40) to 0
    buf.writeUInt32LE(0, 40);

    const filePath = writeWav(dir, "zero-len.wav", buf);
    const info = await readWavInfo(filePath);

    // In readWavInfo, dataBytes is calculated as Math.min(len, size - body).
    // When the header specifies len = 0, Math.min(0, size - body) evaluates to 0.
    // Therefore, even though the file contains actual PCM bytes after the header,
    // readWavInfo reports dataBytes as 0 and durationSec as 0.
    expect(info.dataBytes).toBe(0);
    expect(info.durationSec).toBe(0);
  });

  describe("readWavSlice clamping", () => {
    it("start past the end of audio returns a valid WAV with no PCM bytes", async () => {
      const pcm = createPcm(16_000); // 1.0 s of audio at 16 kHz
      const filePath = writeWav(dir, "slice-past-end.wav", wavFromPcm(pcm, 16_000));
      const info = await readWavInfo(filePath);

      // Request a slice starting at 5.0 s (well beyond the 1.0 s duration)
      const sliceBuf = await readWavSlice(filePath, info, 5.0, 1.0);

      // Verify that the returned buffer is a valid WAV header with 0 data bytes
      expect(sliceBuf.length).toBe(44);
      expect(sliceBuf.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(sliceBuf.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(sliceBuf.readUInt32LE(40)).toBe(0);

      // Also verify via readWavInfo on the resulting slice file
      const sliceFile = writeWav(dir, "slice-past-end-out.wav", sliceBuf);
      const sliceInfo = await readWavInfo(sliceFile);
      expect(sliceInfo.dataBytes).toBe(0);
      expect(sliceInfo.durationSec).toBe(0);
    });

    it("range before audio start (startSec = -1, durSec = 0.5) gives an empty slice", async () => {
      const pcm = createPcm(16_000); // 1.0 s of audio at 16 kHz
      const filePath = writeWav(dir, "slice-neg-empty.wav", wavFromPcm(pcm, 16_000));
      const info = await readWavInfo(filePath);

      // Range [-1 s, -0.5 s) is entirely before audio start, so clamping yields 0 PCM bytes
      const sliceBuf = await readWavSlice(filePath, info, -1, 0.5);

      expect(sliceBuf.length).toBe(44);
      expect(sliceBuf.readUInt32LE(40)).toBe(0);
      expect(sliceBuf.subarray(44).length).toBe(0);
    });

    it("partially negative range (startSec = -1, durSec = 2 on 3 s audio) matches startSec = 0, durSec = 1", async () => {
      const pcm3s = createPcm(3 * 16_000); // 3.0 s of audio at 16 kHz
      const filePath = writeWav(dir, "slice-neg-overlap.wav", wavFromPcm(pcm3s, 16_000));
      const info = await readWavInfo(filePath);

      // Range [-1 s, 1 s) clamped to [0 s, 1 s) yields the same bytes as startSec = 0, durSec = 1
      const sliceNegative = await readWavSlice(filePath, info, -1, 2);
      const sliceZero = await readWavSlice(filePath, info, 0, 1);

      expect(sliceNegative).toEqual(sliceZero);
      expect(sliceNegative.readUInt32LE(40)).toBe(1 * 16_000 * 2);
    });

    it("normal slice returns the expected PCM bytes", async () => {
      const pcm = createPcm(16_000); // 1.0 s of audio at 16 kHz
      const filePath = writeWav(dir, "slice-normal.wav", wavFromPcm(pcm, 16_000));
      const info = await readWavInfo(filePath);

      // Slice [0.25 s, 0.75 s) => 0.5 s duration (8,000 samples = 16,000 bytes)
      const sliceBuf = await readWavSlice(filePath, info, 0.25, 0.5);

      const expectedStartByte = 0.25 * 16_000 * 2; // 8,000 bytes
      const expectedEndByte = 0.75 * 16_000 * 2; // 24,000 bytes
      const expectedPcm = pcm.subarray(expectedStartByte, expectedEndByte);

      // Sliced WAV header indicates 16,000 PCM bytes
      expect(sliceBuf.readUInt32LE(40)).toBe(expectedPcm.length);
      // PCM payload after the 44-byte WAV header matches the expected slice
      expect(sliceBuf.subarray(44)).toEqual(expectedPcm);
    });
  });
});
