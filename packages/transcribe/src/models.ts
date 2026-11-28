/**
 * Downloadable speech models for on-device transcription. Nothing is ever
 * downloaded unless `downloadModel` is called, which the app or CLI does only
 * after the user agrees. Every file is checked against a pinned SHA-256, and a
 * model is staged in a temporary folder that is renamed into place only once
 * every file has verified, so a model folder is either complete or absent.
 */
import { createHash, randomBytes, type Hash } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { readTar } from "./tar.js";
import type { LocalModelId } from "./types.js";

export interface ModelFile {
  url: string;
  sha256: string;
  /** Path of the file inside the model folder (for an archive, its name while it downloads). */
  path: string;
  /** Download size in bytes. */
  bytes?: number;
  /** Set when `url` is a `.tar.bz2`: the files to keep from it, each with its own checksum. */
  archive?: { members: Array<{ name: string; path: string; sha256: string }> };
}

export interface LocalModel {
  label: string;
  /** SPDX id of the model weights' license. */
  license?: string;
  /** Who made the model and where it comes from, for notices and `models list`. */
  attribution?: string;
  /** Total download size in bytes. */
  sizeBytes: number;
  files: ModelFile[];
}

/** Bumped when a model's files change, so an older install reads as not installed. */
const MODEL_VERSIONS: Record<LocalModelId, string> = {
  "english-fast": "parakeet-tdt-ctc-110m-en-int8-1",
  multilingual: "whisper-base-int8-1",
};

const PARAKEET_ARCHIVE =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2";
const PARAKEET_DIR = "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8";
// Pinned to a commit so the bytes behind the URL cannot change under the checksum.
const WHISPER_BASE = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/bb53ee204431c90d314c1cc08d28d23e5b7927cc";

export const LOCAL_MODELS: Record<LocalModelId, LocalModel> = {
  // NVIDIA Parakeet TDT-CTC 110M, English only, int8, run as a CTC model.
  // Same model as Clipy's hosted fast English path. It is only published as
  // an archive (104 MB download, 132 MB unpacked). It fails on long input, so
  // audio is fed in pieces of at most 180 seconds.
  "english-fast": {
    label: "English, fast (Parakeet TDT-CTC 110M)",
    license: "CC-BY-4.0",
    attribution:
      "NVIDIA Parakeet TDT-CTC 110M (https://huggingface.co/nvidia/parakeet-tdt_ctc-110m), CC-BY-4.0, converted to ONNX int8 by the sherpa-onnx project",
    sizeBytes: 104_337_827,
    files: [
      {
        url: PARAKEET_ARCHIVE,
        sha256: "17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b",
        path: "parakeet.tar.bz2",
        bytes: 104_337_827,
        archive: {
          members: [
            {
              name: `${PARAKEET_DIR}/model.int8.onnx`,
              path: "model.int8.onnx",
              sha256: "9177a9146cf32ee0cc8152276ef95116f312018d316be37ccf57f7efea81fc1a",
            },
            {
              name: `${PARAKEET_DIR}/tokens.txt`,
              path: "tokens.txt",
              sha256: "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10",
            },
          ],
        },
      },
    ],
  },
  // OpenAI Whisper base (multilingual, about 99 languages), int8. Base rather
  // than tiny: tiny is a third smaller but noticeably worse outside English,
  // and base still runs well under real time on a laptop CPU (each 30 s
  // window took about 1 s on 2 threads in testing). Whisper reads at most
  // 30 s at a time, so audio is fed in pieces of at most 28 seconds.
  multilingual: {
    label: "All languages (Whisper base)",
    license: "MIT",
    attribution:
      "OpenAI Whisper base (https://github.com/openai/whisper), MIT, converted to ONNX int8 by the sherpa-onnx project",
    sizeBytes: 160_609_290,
    files: [
      {
        url: `${WHISPER_BASE}/base-encoder.int8.onnx`,
        sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11",
        path: "encoder.int8.onnx",
        bytes: 29_120_534,
      },
      {
        url: `${WHISPER_BASE}/base-decoder.int8.onnx`,
        sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d",
        path: "decoder.int8.onnx",
        bytes: 130_672_026,
      },
      {
        url: `${WHISPER_BASE}/base-tokens.txt`,
        sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
        path: "tokens.txt",
        bytes: 816_730,
      },
    ],
  },
};

const MARKER = ".installed.json";

/** Platform cache folder for models: `~/.cache/clipy-local/models` on Linux. */
export function defaultModelDir(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(base, "clipy-local", "models");
  }
  if (process.platform === "darwin") return join(home, "Library", "Caches", "clipy-local", "models");
  const base = process.env.XDG_CACHE_HOME || join(home, ".cache");
  return join(base, "clipy-local", "models");
}

/** Final paths of a model's files inside its folder. */
export function modelFilePaths(model: LocalModelId, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of LOCAL_MODELS[model].files) {
    if (f.archive) for (const m of f.archive.members) out[m.path] = join(dir, m.path);
    else out[f.path] = join(dir, f.path);
  }
  return out;
}

export function modelStatus(model: LocalModelId, modelDir?: string): { installed: boolean; dir: string } {
  if (!(model in LOCAL_MODELS)) throw new Error(`Unknown local model "${model}"`);
  const dir = join(modelDir ?? defaultModelDir(), model);
  let installed = false;
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { version?: string };
    installed = marker.version === MODEL_VERSIONS[model] && Object.values(modelFilePaths(model, dir)).every((p) => existsSync(p));
  } catch {
    installed = false;
  }
  return { installed, dir };
}

export function formatBytes(n: number): string {
  return `${Math.round(n / 1_000_000)} MB`;
}

export class ChecksumError extends Error {
  constructor(what: string) {
    super(`Checksum mismatch for ${what}: the download is corrupt or was changed. Nothing was installed; try again.`);
    this.name = "ChecksumError";
  }
}

function cancelled(): Error {
  const err = new Error("Model download was cancelled");
  err.name = "AbortError";
  return err;
}

export class DownloadTooLargeError extends Error {
  constructor(what: string, maxBytes: number) {
    super(`The download of ${what} is larger than the expected ${maxBytes} bytes, so it was stopped. Nothing was installed.`);
    this.name = "DownloadTooLargeError";
  }
}

/** A model download that receives nothing for this long is abandoned. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * Stream `url` to `dest`, hashing as it goes. Throws ChecksumError on a
 * mismatch. With `maxBytes` (the file's expected size), a server that sends
 * more is cut off at that size instead of filling the disk.
 *
 * Redirects are followed: the model hosts serve from a CDN, and no key or
 * other credential is sent with these requests.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  sha256: string,
  label: string,
  signal?: AbortSignal,
  onBytes?: (n: number) => void,
  maxBytes?: number,
  idleMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<void> {
  await transfer(url, dest, sha256, label, signal, onBytes, maxBytes, idleMs, false);
}

/**
 * Like `downloadVerified`, but `dest` may already hold the start of the file
 * from an earlier attempt. The rest is asked for with a `Range` request and
 * appended when the server answers 206 with a matching `Content-Range`; on a
 * 200 (the server ignored the range) or a 416 the file starts over from byte
 * 0. The checksum and `maxBytes` always cover the whole file, including the
 * bytes already on disk, and `onBytes` is told about those bytes too.
 */
export async function downloadResumable(
  url: string,
  dest: string,
  sha256: string,
  label: string,
  signal?: AbortSignal,
  onBytes?: (n: number) => void,
  maxBytes?: number,
  idleMs: number = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<void> {
  await transfer(url, dest, sha256, label, signal, onBytes, maxBytes, idleMs, true);
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Feed a file on disk into `hash`, in chunks. */
async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

async function fileMatches(path: string, sha256: string): Promise<boolean> {
  const hash = createHash("sha256");
  await hashFile(path, hash);
  return hash.digest("hex") === sha256.toLowerCase();
}

/** The first byte a 206 response covers, from `Content-Range: bytes <start>-<end>/<total>`. */
function rangeStart(res: Response): number | null {
  const m = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(res.headers.get("content-range")?.trim() ?? "");
  return m ? Number(m[1]) : null;
}

async function transfer(
  url: string,
  dest: string,
  sha256: string,
  label: string,
  signal: AbortSignal | undefined,
  onBytes: ((n: number) => void) | undefined,
  maxBytes: number | undefined,
  idleMs: number,
  resume: boolean,
): Promise<void> {
  let offset = resume ? await sizeOf(dest) : 0;
  // A file that already reached its full size (the process stopped before
  // renaming it) needs no request at all if it verifies.
  if (offset > 0 && maxBytes !== undefined && offset >= maxBytes) {
    if (offset === maxBytes && (await fileMatches(dest, sha256))) {
      onBytes?.(offset);
      return;
    }
    offset = 0;
  }
  // Abandon a connection that stops sending: the clock restarts on every chunk.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleMs);
  };
  const stalled = () => new Error(`Could not download ${label}: the connection stalled (nothing received for ${Math.round(idleMs / 1000)} s)`);
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
  const request = async (from: number): Promise<Response> => {
    bump();
    try {
      const headers: Record<string, string> = from > 0 ? { range: `bytes=${from}-` } : {};
      return await fetch(url, { signal: combined, redirect: "follow", headers });
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      if (idle.signal.aborted) throw stalled();
      const code = (err as { cause?: { code?: string } }).cause?.code;
      throw new Error(`Could not download ${label}: ${code ? `network error (${code})` : "the server could not be reached"}`);
    }
  };
  try {
    let res = await request(offset);
    if (offset > 0 && !(res.status === 206 && rangeStart(res) === offset)) {
      if (res.status === 206 || res.status === 416) {
        // A range we did not ask for, or one past the end of the file: start over.
        await res.body?.cancel().catch(() => undefined);
        res = await request(0);
      }
      // A 200 is the whole file. An error is reported by saveVerified before it
      // opens `dest`, so the bytes already there are kept for the next attempt.
      offset = 0;
    }
    bump();
    await saveVerified(res, dest, sha256, label, signal, onBytes, maxBytes, bump, () => idle.signal.aborted, stalled, offset);
  } finally {
    clearTimeout(timer);
  }
}

async function saveVerified(
  res: Response,
  dest: string,
  sha256: string,
  label: string,
  signal: AbortSignal | undefined,
  onBytes: ((n: number) => void) | undefined,
  maxBytes: number | undefined,
  bump: () => void,
  isStalled: () => boolean,
  stalled: () => Error,
  /** Bytes of the file already in `dest`; the response carries the rest. */
  offset = 0,
): Promise<void> {
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Could not download ${label} (HTTP ${res.status})`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (maxBytes !== undefined && Number.isFinite(declared) && offset + declared > maxBytes) {
    await res.body.cancel().catch(() => undefined);
    throw new DownloadTooLargeError(label, maxBytes);
  }
  const hash = createHash("sha256");
  if (offset > 0) {
    await hashFile(dest, hash);
    onBytes?.(offset);
  }
  const fh = await open(dest, offset > 0 ? "a" : "w");
  let received = offset;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      received += value.byteLength;
      if (maxBytes !== undefined && received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DownloadTooLargeError(label, maxBytes);
      }
      hash.update(value);
      await fh.write(value);
      onBytes?.(value.byteLength);
    }
  } catch (err) {
    if (err instanceof DownloadTooLargeError) throw err;
    if (signal?.aborted) throw cancelled();
    if (isStalled()) throw stalled();
    throw new Error(`Could not download ${label}: the connection dropped`);
  } finally {
    await fh.close();
  }
  if (hash.digest("hex") !== sha256.toLowerCase()) throw new ChecksumError(label);
}

/** Staging folders a `downloadModel` call in this process is using right now. */
const activeStages = new Set<string>();

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) total += await sizeOf(join(dir, name));
  return total;
}

/**
 * Pick the staging folder for a download of `model`. A folder this model's
 * earlier attempt left behind (in a process that has died, or in this one
 * after a failed call) is taken over by renaming it, so its finished files
 * and partial file are reused; when there are several, the fullest wins and
 * the rest are removed. Folders of other models whose process died before it
 * could clean up (killed, power loss) are removed as before. A folder whose
 * process is still running belongs to a download in progress and is left
 * alone.
 */
async function claimStage(root: string, model: LocalModelId): Promise<string> {
  const stage = join(root, `.${model}.partial-${process.pid}-${randomBytes(4).toString("hex")}`);
  const ours: string[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const m = /^\.(.+)\.partial-(\d+)-[0-9a-f]+$/.exec(name);
    if (!m) continue;
    const path = join(root, name);
    const pid = Number(m[2]);
    if (activeStages.has(path)) continue;
    const mine = pid === process.pid;
    if (!mine && processAlive(pid)) continue;
    if (m[1] === model) ours.push(path);
    else if (!mine) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
  const sizes = await Promise.all(ours.map(folderBytes));
  const best = ours[sizes.indexOf(Math.max(...sizes))];
  for (const path of ours) if (path !== best) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  if (best !== undefined) {
    try {
      // Renaming claims it: another process taking over the same folder loses the race.
      await rename(best, stage);
      return stage;
    } catch {
      // Taken by someone else; start a fresh one.
    }
  }
  await mkdir(stage, { recursive: true });
  return stage;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Decompress a .bz2 file on a worker thread so the event loop stays free. */
function bunzip2(path: string, signal?: AbortSignal): Promise<Buffer> {
  const bzipPath = createRequire(import.meta.url).resolve("seek-bzip");
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const Bunzip = require(workerData.bzipPath);
    const out = Bunzip.decode(fs.readFileSync(workerData.path));
    const ab = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
    parentPort.postMessage(ab, [ab]);
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { bzipPath, path } });
    const onAbort = () => {
      void worker.terminate();
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (ab: ArrayBuffer) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(Buffer.from(ab));
    });
    worker.once("error", () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("The model archive could not be unpacked"));
    });
  });
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Pull the listed members out of a verified archive, checking each one. */
export async function extractArchiveMembers(
  archivePath: string,
  members: Array<{ name: string; path: string; sha256: string }>,
  outDir: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  const tar = await bunzip2(archivePath, signal);
  const wanted = new Map(members.map((m) => [m.name, m]));
  const found = new Set<string>();
  for (const entry of readTar(tar)) {
    const m = wanted.get(entry.name);
    if (!m) continue;
    if (sha256Hex(entry.data) !== m.sha256.toLowerCase()) throw new ChecksumError(`${label} (${m.path})`);
    const tmp = join(outDir, `.${m.path}.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, entry.data);
    await rename(tmp, join(outDir, m.path));
    found.add(m.name);
  }
  const missing = members.filter((m) => !found.has(m.name));
  if (missing.length) throw new Error(`The ${label} archive is missing ${missing.map((m) => m.path).join(", ")}`);
}

/** True when an earlier attempt already unpacked every member of an archive, each with the right checksum. */
async function membersUnpacked(stage: string, members: Array<{ path: string; sha256: string }>): Promise<boolean> {
  for (const m of members) {
    const path = join(stage, m.path);
    if (!existsSync(path) || !(await fileMatches(path, m.sha256))) return false;
  }
  return true;
}

/**
 * Download, verify and install a model. Returns its folder. Safe to call
 * again: an installed model is returned as is.
 *
 * An interrupted download picks up where it stopped on the next call, in
 * this process or a later one: files that finished and verified are kept,
 * and the one that was cut off resumes with a `Range` request (see
 * `downloadResumable`). The staging folder is removed instead when the
 * download is cancelled, fails its checksum or is larger than expected, so
 * bad bytes are never resumed.
 */
export async function downloadModel(
  model: LocalModelId,
  options: { modelDir?: string; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<string> {
  const spec = LOCAL_MODELS[model];
  if (!spec) throw new Error(`Unknown local model "${model}"`);
  const root = options.modelDir ?? defaultModelDir();
  const status = modelStatus(model, root);
  if (status.installed) {
    options.onProgress?.(1);
    return status.dir;
  }
  await mkdir(root, { recursive: true });
  const stage = await claimStage(root, model);
  activeStages.add(stage);
  const hasArchive = spec.files.some((f) => f.archive);
  const total = spec.files.reduce((n, f) => n + (f.bytes ?? 0), 0) || spec.sizeBytes;
  const downloadShare = hasArchive ? 0.85 : 1;
  let done = 0;
  const report = (n: number) => {
    done += n;
    options.onProgress?.(Math.min(downloadShare, (done / total) * downloadShare));
  };
  try {
    options.onProgress?.(0);
    if (options.signal?.aborted) throw cancelled();
    for (const f of spec.files) {
      const dest = join(stage, f.path);
      // A file only gets its final name once it has verified; check it again
      // anyway, since the folder may come from an earlier version of this code.
      if (existsSync(dest) && !(await fileMatches(dest, f.sha256))) await rm(dest, { force: true });
      if (existsSync(dest) || (f.archive && (await membersUnpacked(stage, f.archive.members)))) {
        report(f.bytes ?? (await sizeOf(dest)));
      } else {
        // Named after the checksum, so bytes of a different version are never resumed.
        const part = `${dest}.${f.sha256.slice(0, 16)}.part`;
        await downloadResumable(f.url, part, f.sha256, spec.label, options.signal, report, f.bytes);
        await rename(part, dest);
      }
      if (f.archive && existsSync(dest)) {
        await extractArchiveMembers(dest, f.archive.members, stage, spec.label, options.signal);
        await rm(dest, { force: true });
      }
    }
    // A reused folder can hold leftovers of an older attempt (a partial file
    // of another version, an unfinished unpack); they do not belong in the model.
    for (const name of await readdir(stage)) {
      if (name.endsWith(".part") || name.endsWith(".tmp")) await rm(join(stage, name), { force: true });
    }
    await writeFile(join(stage, MARKER), JSON.stringify({ model, version: MODEL_VERSIONS[model], installedAt: new Date().toISOString() }, null, 2));
    const final = status.dir;
    await rm(final, { recursive: true, force: true });
    await rename(stage, final);
    options.onProgress?.(1);
    return final;
  } catch (err) {
    const aborted = options.signal?.aborted === true;
    // Keep what was downloaded only when the next attempt can build on it.
    if (aborted || err instanceof ChecksumError || err instanceof DownloadTooLargeError) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
    if (aborted) throw cancelled();
    throw err;
  } finally {
    activeStages.delete(stage);
  }
}
