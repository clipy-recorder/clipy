import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readWavInfo, readWavSlice, wavFromPcm } from "../src/audio.js";
import { tempDir } from "./helpers.js";

// Every WAV here is built in memory, so none of these tests need ffmpeg.

const dir = tempDir("clipy-wav-test-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fileCount = 0;
function writeFile(bytes: Buffer): string {
  const path = join(dir, `${fileCount++}.wav`);
  writeFileSync(path, bytes);
  return path;
}

/** PCM bytes where every 16-bit sample differs from its neighbours, so a slice taken from the wrong place shows. */
function pcm(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = i % 251;
  return buf;
}

/** One RIFF chunk. `declared` overrides the length field; an odd-sized body gets its pad byte. */
function chunk(id: string, body: Buffer, declared = body.length): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, "ascii");
  head.writeUInt32LE(declared, 4);
  return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
}

/** The body of a PCM `fmt ` chunk. */
function fmtBody(sampleRate: number, channels: number, bits: number): Buffer {
  const body = Buffer.alloc(16);
  const blockAlign = channels * (bits / 8);
  body.writeUInt16LE(1, 0); // PCM
  body.writeUInt16LE(channels, 2);
  body.writeUInt32LE(sampleRate, 4);
  body.writeUInt32LE(sampleRate * blockAlign, 8);
  body.writeUInt16LE(blockAlign, 12);
  body.writeUInt16LE(bits, 14);
  return body;
}

/** A RIFF/WAVE file holding exactly the given chunks, in order. */
function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
}

describe("readWavInfo", () => {
  it("reads a plain 16 kHz mono file", async () => {
    const path = writeFile(wavFromPcm(pcm(32_000)));
    expect(await readWavInfo(path)).toEqual({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 32_000,
      durationSec: 1,
    });
  });

  it("skips an odd-length LIST chunk and its pad byte before fmt", async () => {
    const list = chunk("LIST", Buffer.from("INFOx", "ascii")); // 5 bytes + 1 pad
    const path = writeFile(riff(list, chunk("fmt ", fmtBody(16_000, 1, 16)), chunk("data", pcm(16_000))));
    const info = await readWavInfo(path);
    // 12 (RIFF header) + 8 + 5 + 1 (LIST) + 8 + 16 (fmt) + 8 (data header)
    expect(info.dataOffset).toBe(58);
    expect(info).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, dataBytes: 16_000, durationSec: 0.5 });
  });

  it("skips an odd-length LIST chunk between fmt and data", async () => {
    const list = chunk("LIST", Buffer.from("INFOabc", "ascii")); // 7 bytes + 1 pad
    const path = writeFile(riff(chunk("fmt ", fmtBody(16_000, 1, 16)), list, chunk("data", pcm(3_200))));
    const info = await readWavInfo(path);
    // 12 + 8 + 16 (fmt) + 8 + 7 + 1 (LIST) + 8 (data header)
    expect(info.dataOffset).toBe(60);
    expect(info.dataBytes).toBe(3_200);
    expect(info.durationSec).toBeCloseTo(0.1, 10);
  });

  it("works out the duration of 48 kHz stereo from all of its channels", async () => {
    // 48 000 frames/s * 2 channels * 2 bytes = 192 000 bytes per second.
    const path = writeFile(riff(chunk("fmt ", fmtBody(48_000, 2, 16)), chunk("data", pcm(96_000))));
    expect(await readWavInfo(path)).toEqual({
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 96_000,
      durationSec: 0.5,
    });
  });

  it("counts the bit depth in the duration of 24-bit audio", async () => {
    // 48 000 frames/s * 2 channels * 3 bytes = 288 000 bytes per second.
    const path = writeFile(riff(chunk("fmt ", fmtBody(48_000, 2, 24)), chunk("data", pcm(144_000))));
    expect(await readWavInfo(path)).toEqual({
      sampleRate: 48_000,
      channels: 2,
      bitsPerSample: 24,
      dataOffset: 44,
      dataBytes: 144_000,
      durationSec: 0.5,
    });
  });

  it("uses the file size when a streamed WAV says its data is 0xFFFFFFFF bytes", async () => {
    const wav = wavFromPcm(pcm(8_000));
    wav.writeUInt32LE(0xffffffff, 4);
    wav.writeUInt32LE(0xffffffff, 40);
    const info = await readWavInfo(writeFile(wav));
    expect(info.dataBytes).toBe(8_000);
    expect(info.durationSec).toBe(0.25);
  });

  it("uses the file size when the data length runs past the end of the file", async () => {
    const wav = wavFromPcm(pcm(8_000));
    wav.writeUInt32LE(1_000_000, 40);
    expect((await readWavInfo(writeFile(wav))).dataBytes).toBe(8_000);
  });

  it("reads a data length of 0 as 0 s, even when PCM bytes follow", async () => {
    // Current behaviour, pinned so a change to it is deliberate. See the pull request.
    const wav = wavFromPcm(pcm(8_000));
    wav.writeUInt32LE(0, 40);
    const info = await readWavInfo(writeFile(wav));
    expect(info.dataOffset).toBe(44);
    expect(info.dataBytes).toBe(0);
    expect(info.durationSec).toBe(0);
  });

  it("rejects a file that is not RIFF", async () => {
    const path = writeFile(Buffer.from("this is plain text, not audio at all", "ascii"));
    await expect(readWavInfo(path)).rejects.toThrow(`${path} is not a WAV file`);
  });

  it("rejects a RIFF file that is not WAVE", async () => {
    const avi = riff(chunk("fmt ", fmtBody(16_000, 1, 16)));
    avi.write("AVI ", 8, "ascii");
    await expect(readWavInfo(writeFile(avi))).rejects.toThrow(/is not a WAV file/);
  });

  it("rejects an empty file", async () => {
    await expect(readWavInfo(writeFile(Buffer.alloc(0)))).rejects.toThrow(/is not a WAV file/);
  });

  it("rejects a data chunk that comes before fmt", async () => {
    const path = writeFile(riff(chunk("data", pcm(1_600)), chunk("fmt ", fmtBody(16_000, 1, 16))));
    await expect(readWavInfo(path)).rejects.toThrow(`${path} has no PCM data chunk`);
  });

  it("rejects a file with no data chunk", async () => {
    const path = writeFile(riff(chunk("fmt ", fmtBody(16_000, 1, 16)), chunk("LIST", Buffer.from("INFO", "ascii"))));
    await expect(readWavInfo(path)).rejects.toThrow(`${path} has no PCM data chunk`);
  });
});

describe("readWavSlice", () => {
  // 1 s of 16 kHz mono: 32 000 bytes, 32 bytes per millisecond.
  const audio = pcm(32_000);

  async function setup(bytes = wavFromPcm(audio)) {
    const path = writeFile(bytes);
    return { path, info: await readWavInfo(path) };
  }

  it("cuts the requested range into its own WAV", async () => {
    const { path, info } = await setup();
    const slice = await readWavSlice(path, info, 0.25, 0.5);
    // 0.25 s to 0.75 s is bytes 8 000 to 24 000.
    expect(slice).toEqual(wavFromPcm(audio.subarray(8_000, 24_000)));
  });

  it("reads from the data chunk when a LIST chunk moves it", async () => {
    const list = chunk("LIST", Buffer.from("INFOx", "ascii"));
    const { path, info } = await setup(riff(list, chunk("fmt ", fmtBody(16_000, 1, 16)), chunk("data", audio)));
    expect(info.dataOffset).toBe(58);
    const slice = await readWavSlice(path, info, 0.5, 0.25);
    expect(slice.subarray(44)).toEqual(audio.subarray(16_000, 24_000));
  });

  it("stops at the end of the audio when the range runs past it", async () => {
    const { path, info } = await setup();
    const slice = await readWavSlice(path, info, 0.75, 1);
    expect(slice.readUInt32LE(40)).toBe(8_000);
    expect(slice.subarray(44)).toEqual(audio.subarray(24_000));
  });

  it("returns an empty WAV when the range starts after the end", async () => {
    const { path, info } = await setup();
    const slice = await readWavSlice(path, info, 2, 1);
    expect(slice.length).toBe(44);
    expect(slice.readUInt32LE(40)).toBe(0);
    expect(slice.toString("ascii", 0, 4)).toBe("RIFF");
  });

  it("starts at 0 when the range starts before it", async () => {
    const { path, info } = await setup();
    const slice = await readWavSlice(path, info, -0.25, 0.5);
    // The end stays at -0.25 + 0.5 = 0.25 s; only the start is clamped.
    expect(slice.readUInt32LE(40)).toBe(8_000);
    expect(slice.subarray(44)).toEqual(audio.subarray(0, 8_000));
  });

  it("returns an empty WAV when the whole range is before 0", async () => {
    const { path, info } = await setup();
    const slice = await readWavSlice(path, info, -1, 0.5);
    expect(slice.readUInt32LE(40)).toBe(0);
    expect(slice.length).toBe(44);
  });
});
