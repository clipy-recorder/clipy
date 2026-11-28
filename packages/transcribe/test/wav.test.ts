import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readWavInfo, readWavSlice, wavFromPcm } from "../src/audio.js";
import { tempDir } from "./helpers.js";

const dir = tempDir("clipy-wav-test-");
let n = 0;

function write(buf: Buffer): string {
  const p = join(dir, `t${n++}.wav`);
  writeFileSync(p, buf);
  return p;
}

function fmtChunk(channels: number, sampleRate: number, bits: number): Buffer {
  const c = Buffer.alloc(24);
  c.write("fmt ", 0, "ascii");
  c.writeUInt32LE(16, 4);
  c.writeUInt16LE(1, 8); // PCM
  c.writeUInt16LE(channels, 10);
  c.writeUInt32LE(sampleRate, 12);
  c.writeUInt32LE((sampleRate * channels * bits) / 8, 16);
  c.writeUInt16LE((channels * bits) / 8, 20);
  c.writeUInt16LE(bits, 22);
  return c;
}

function chunk(id: string, body: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(id, 0, "ascii");
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(12);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(4 + body.length, 4);
  h.write("WAVE", 8, "ascii");
  return Buffer.concat([h, body]);
}

describe("readWavInfo", () => {
  it("reads a canonical 44-byte-header WAV", async () => {
    const pcm = Buffer.alloc(32000); // 1 s of 16 kHz mono 16-bit
    const info = await readWavInfo(write(wavFromPcm(pcm)));
    expect(info).toEqual({ sampleRate: 16000, channels: 1, bitsPerSample: 16, dataOffset: 44, dataBytes: 32000, durationSec: 1 });
  });

  it("computes duration from sample rate, channels and bit depth", async () => {
    const pcm = Buffer.alloc(48000 * 2 * 3 * 2); // 2 s, 48 kHz stereo 24-bit
    const info = await readWavInfo(write(riff(fmtChunk(2, 48000, 24), chunk("data", pcm))));
    expect(info).toMatchObject({ sampleRate: 48000, channels: 2, bitsPerSample: 24, dataBytes: pcm.length });
    expect(info.durationSec).toBeCloseTo(2, 6);
  });

  it("skips extra chunks such as LIST before the data chunk", async () => {
    const list = chunk("LIST", Buffer.from("INFOISFT\x05\x00\x00\x00Clipy\x00", "binary"));
    const pcm = Buffer.alloc(3200);
    const file = riff(fmtChunk(1, 16000, 16), list, chunk("data", pcm));
    const info = await readWavInfo(write(file));
    expect(info.dataOffset).toBe(file.length - pcm.length);
    expect(info.dataBytes).toBe(3200);
    expect(info.durationSec).toBeCloseTo(0.1, 6);
  });

  it("honours the pad byte after an odd-sized chunk", async () => {
    const odd = chunk("junk", Buffer.from([1, 2, 3])); // 3 bytes + 1 pad byte
    const pcm = Buffer.alloc(640);
    const info = await readWavInfo(write(riff(fmtChunk(1, 16000, 16), odd, chunk("data", pcm))));
    expect(info.dataBytes).toBe(640);
  });

  it("trusts the file size when a streamed WAV has a placeholder data length", async () => {
    const pcm = Buffer.alloc(16000);
    const file = wavFromPcm(pcm);
    file.writeUInt32LE(0xffffffff, 40); // unknown length, as written by a live encoder
    const info = await readWavInfo(write(file));
    expect(info.dataBytes).toBe(16000);
    expect(info.durationSec).toBeCloseTo(0.5, 6);
  });

  it("clamps a data length that runs past the end of a truncated file", async () => {
    const file = wavFromPcm(Buffer.alloc(32000));
    const info = await readWavInfo(write(file.subarray(0, 44 + 8000)));
    expect(info.dataBytes).toBe(8000);
  });

  it("reports an empty data chunk as zero seconds", async () => {
    const info = await readWavInfo(write(wavFromPcm(Buffer.alloc(0))));
    expect(info.dataBytes).toBe(0);
    expect(info.durationSec).toBe(0);
  });

  it("rejects a file that is not RIFF/WAVE", async () => {
    await expect(readWavInfo(write(Buffer.from("this is definitely not audio at all")))).rejects.toThrow(/not a WAV file/);
    const wrongForm = wavFromPcm(Buffer.alloc(100));
    wrongForm.write("AVI ", 8, "ascii");
    await expect(readWavInfo(write(wrongForm))).rejects.toThrow(/not a WAV file/);
  });

  it("rejects an empty file", async () => {
    await expect(readWavInfo(write(Buffer.alloc(0)))).rejects.toThrow(/not a WAV file/);
  });

  it("rejects a header with no data chunk", async () => {
    await expect(readWavInfo(write(riff(fmtChunk(1, 16000, 16))))).rejects.toThrow(/no PCM data chunk/);
  });

  it("rejects a data chunk that comes before the fmt chunk", async () => {
    await expect(readWavInfo(write(riff(chunk("data", Buffer.alloc(100)), fmtChunk(1, 16000, 16))))).rejects.toThrow(/no PCM data chunk/);
  });
});

describe("readWavSlice", () => {
  it("returns a valid WAV holding just the requested stretch", async () => {
    const pcm = Buffer.alloc(32000);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE((i / 2) % 1000, i);
    const path = write(wavFromPcm(pcm));
    const info = await readWavInfo(path);

    const slice = await readWavSlice(path, info, 0.25, 0.5);
    const sliceInfo = await readWavInfo(write(slice));
    expect(sliceInfo).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, dataBytes: 16000 });
    expect(slice.subarray(44).equals(pcm.subarray(8000, 24000))).toBe(true);
  });

  it("clamps a slice that runs past the end", async () => {
    const path = write(wavFromPcm(Buffer.alloc(32000)));
    const info = await readWavInfo(path);
    const slice = await readWavSlice(path, info, 0.75, 5);
    expect(slice.readUInt32LE(40)).toBe(8000);
  });
});
