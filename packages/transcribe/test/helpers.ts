import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { readWavInfo, wavFromPcm } from "../src/audio.js";
import type { SilenceSpan } from "../src/chunking.js";
import type { AudioInput } from "../src/providers/common.js";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

export interface FakeServer {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export async function fakeServer(handler: Handler): Promise<FakeServer> {
  const requests: Recorded[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rec: Recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(rec);
    try {
      await handler(rec, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function json(res: ServerResponse, body: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** Parse a multipart body the way a server would. */
export async function formData(rec: Recorded): Promise<FormData> {
  return new Request("http://x/", { method: "POST", headers: { "content-type": String(rec.headers["content-type"]) }, body: new Uint8Array(rec.body) }).formData();
}

export function tempDir(prefix = "clipy-transcribe-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A 16 kHz mono WAV of `seconds`, a quiet ramp so every byte differs. */
export function writeTestWav(seconds: number, dir = tempDir()): string {
  const samples = Math.round(seconds * 16000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE((i % 2000) - 1000, i * 2);
  const path = join(dir, "audio.wav");
  writeFileSync(path, wavFromPcm(pcm));
  return path;
}

export async function audioInput(seconds: number, silences: SilenceSpan[] = []): Promise<AudioInput & { progress: number[] }> {
  const wavPath = writeTestWav(seconds);
  const progress: number[] = [];
  return { wavPath, info: await readWavInfo(wavPath), silences: async () => silences, onProgress: (f) => progress.push(f), progress };
}

/** Seconds of audio in a WAV held in memory. */
export function wavSeconds(buf: Buffer): number {
  return buf.readUInt32LE(40) / 32000;
}

export function hasCommand(cmd: string, versionArg = "--version"): boolean {
  try {
    execFileSync(cmd, [versionArg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
