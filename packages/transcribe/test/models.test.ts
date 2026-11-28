import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audioInput, fakeServer, hasCommand, tempDir, type FakeServer } from "./helpers.js";
import {
  ChecksumError,
  defaultModelDir,
  downloadModel,
  downloadVerified,
  DownloadTooLargeError,
  LOCAL_MODELS,
  modelStatus,
  type LocalModel,
} from "../src/models.js";
import { ModelNotInstalledError, transcribeLocal } from "../src/local.js";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

let server: FakeServer;
const files = new Map<string, Buffer>();
let saved: Record<string, LocalModel>;

beforeEach(async () => {
  files.clear();
  server = await fakeServer((req, res) => {
    const body = files.get(req.url);
    if (!body) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-length", body.length);
    res.end(body);
  });
  saved = JSON.parse(JSON.stringify(LOCAL_MODELS));
});

afterEach(async () => {
  await server.close();
  Object.assign(LOCAL_MODELS, saved);
});

describe("LOCAL_MODELS", () => {
  it("pins a checksum for every file and a size for every model", () => {
    for (const m of Object.values(LOCAL_MODELS)) {
      expect(m.sizeBytes).toBeGreaterThan(50_000_000);
      expect(m.files.reduce((n, f) => n + (f.bytes ?? 0), 0)).toBe(m.sizeBytes);
      for (const f of m.files) {
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.url).toMatch(/^https:\/\//);
        for (const member of f.archive?.members ?? []) expect(member.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      // Model weights carry their own licenses, which the notices repeat.
      expect(m.license).toMatch(/^(MIT|CC-BY-4\.0)$/);
      expect(m.attribution).toMatch(/https:\/\//);
    }
  });

  it("uses a per-user cache folder", () => {
    expect(defaultModelDir()).toMatch(/clipy-local[\\/]models$/);
  });
});

describe("defaultModelDir", () => {
  it("uses an absolute XDG_CACHE_HOME on Linux, else ~/.cache", () => {
    expect(defaultModelDir({ HOME: "/home/ana", XDG_CACHE_HOME: "/xdg" }, "linux")).toBe("/xdg/clipy-local/models");
    expect(defaultModelDir({ HOME: "/home/ana" }, "linux")).toBe("/home/ana/.cache/clipy-local/models");
    // The XDG spec says to ignore a blank or relative value, as configPath does.
    expect(defaultModelDir({ HOME: "/home/ana", XDG_CACHE_HOME: "rel/cache" }, "linux")).toBe(
      "/home/ana/.cache/clipy-local/models",
    );
    expect(defaultModelDir({ HOME: "/home/ana", XDG_CACHE_HOME: "  " }, "linux")).toBe(
      "/home/ana/.cache/clipy-local/models",
    );
  });

  it("uses Caches on macOS, ignoring XDG_CACHE_HOME", () => {
    expect(defaultModelDir({ HOME: "/Users/ana", XDG_CACHE_HOME: "/xdg" }, "darwin")).toBe(
      "/Users/ana/Library/Caches/clipy-local/models",
    );
  });

  it("uses %LOCALAPPDATA% on Windows, else the profile folder", () => {
    expect(defaultModelDir({ LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" }, "win32")).toBe(
      "C:\\Users\\ana\\AppData\\Local\\clipy-local\\models",
    );
    expect(defaultModelDir({ USERPROFILE: "C:\\Users\\ana" }, "win32")).toBe(
      "C:\\Users\\ana\\AppData\\Local\\clipy-local\\models",
    );
  });
});

describe("downloadVerified", () => {
  it("rejects a file whose checksum does not match", async () => {
    files.set("/f.bin", Buffer.from("tampered"));
    const dest = join(tempDir(), "f.bin");
    await expect(downloadVerified(`${server.url}/f.bin`, dest, sha("original"), "Test model")).rejects.toBeInstanceOf(ChecksumError);
  });

  it("stops a download that is larger than expected, declared or streamed", async () => {
    files.set("/big.bin", Buffer.alloc(5000, 1));
    const dest = join(tempDir(), "big.bin");
    // Declared too large: refused before anything is written.
    await expect(downloadVerified(`${server.url}/big.bin`, dest, sha(Buffer.alloc(5000, 1)), "Test model", undefined, undefined, 1000)).rejects.toBeInstanceOf(
      DownloadTooLargeError,
    );
    // No Content-Length: cut off while streaming, never past the cap.
    const streamed = await fakeServer((_req, res) => {
      res.write(Buffer.alloc(800, 1));
      res.end(Buffer.alloc(800, 1));
    });
    try {
      let written = 0;
      await expect(
        downloadVerified(`${streamed.url}/x`, dest, sha("x"), "Test model", undefined, (n) => (written += n), 1000),
      ).rejects.toBeInstanceOf(DownloadTooLargeError);
      expect(written).toBeLessThanOrEqual(1000);
    } finally {
      await streamed.close();
    }
  });

  it("gives up on a connection that stops sending, and keeps going while it sends", async () => {
    const dest = join(tempDir(), "slow.bin");
    // Headers never come.
    const silent = await fakeServer(() => new Promise(() => undefined));
    // Starts, then stalls mid-body.
    const stalls = await fakeServer((_req, res) => {
      res.setHeader("content-length", 1000);
      res.write(Buffer.alloc(100, 1));
    });
    // Slow but steady: a chunk every 80 ms, well inside the idle limit, 640 ms in all.
    const body = Buffer.alloc(800, 2);
    const steady = await fakeServer(async (_req, res) => {
      res.setHeader("content-length", body.length);
      for (let i = 0; i < 8; i++) {
        res.write(body.subarray(i * 100, (i + 1) * 100));
        await new Promise((r) => setTimeout(r, 80));
      }
      res.end();
    });
    try {
      await expect(downloadVerified(`${silent.url}/x`, dest, sha("x"), "Test model", undefined, undefined, undefined, 200)).rejects.toThrow(
        /stalled/,
      );
      await expect(downloadVerified(`${stalls.url}/x`, dest, sha("x"), "Test model", undefined, undefined, undefined, 200)).rejects.toThrow(
        /stalled/,
      );
      await downloadVerified(`${steady.url}/x`, dest, sha(body), "Test model", undefined, undefined, undefined, 300);
      expect(readFileSync(dest)).toEqual(body);
    } finally {
      await Promise.all([silent.close(), stalls.close(), steady.close()]);
    }
  });

  it("reports HTTP failures with the status only", async () => {
    await expect(downloadVerified(`${server.url}/missing`, join(tempDir(), "x"), sha("x"), "Test model")).rejects.toThrow(
      "Could not download Test model (HTTP 404)",
    );
  });
});

describe("downloadModel", () => {
  function pointMultilingualAtServer(corrupt = false) {
    const parts = { "encoder.int8.onnx": "enc-bytes", "decoder.int8.onnx": "dec-bytes".repeat(1000), "tokens.txt": "tok" };
    LOCAL_MODELS.multilingual = {
      label: "Test multilingual",
      sizeBytes: 0,
      files: Object.entries(parts).map(([path, content]) => {
        files.set(`/${path}`, Buffer.from(corrupt && path === "tokens.txt" ? "bad" : content));
        return { url: `${server.url}/${path}`, sha256: sha(content), path, bytes: content.length };
      }),
    };
  }

  it("installs, verifies, writes a marker, and is idempotent", async () => {
    pointMultilingualAtServer();
    const root = tempDir();
    expect(modelStatus("multilingual", root)).toEqual({ installed: false, dir: join(root, "multilingual") });
    const progress: number[] = [];
    const dir = await downloadModel("multilingual", { modelDir: root, onProgress: (f) => progress.push(f) });
    expect(dir).toBe(join(root, "multilingual"));
    expect(modelStatus("multilingual", root).installed).toBe(true);
    expect(readFileSync(join(dir, "tokens.txt"), "utf8")).toBe("tok");
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);
    expect(readdirSync(root)).toEqual(["multilingual"]);
    const requests = server.requests.length;
    await downloadModel("multilingual", { modelDir: root });
    expect(server.requests.length).toBe(requests);
  });

  it("installs nothing when a checksum fails and leaves no partial folder", async () => {
    pointMultilingualAtServer(true);
    const root = tempDir();
    await expect(downloadModel("multilingual", { modelDir: root })).rejects.toBeInstanceOf(ChecksumError);
    expect(modelStatus("multilingual", root).installed).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("replaces a broken install", async () => {
    pointMultilingualAtServer();
    const root = tempDir();
    mkdirSync(join(root, "multilingual"));
    writeFileSync(join(root, "multilingual", "encoder.int8.onnx"), "half");
    expect(modelStatus("multilingual", root).installed).toBe(false);
    await downloadModel("multilingual", { modelDir: root });
    expect(readFileSync(join(root, "multilingual", "encoder.int8.onnx"), "utf8")).toBe("enc-bytes");
  });

  it.runIf(hasCommand("bzip2"))("unpacks the verified files from a .tar.bz2 archive", async () => {
    const src = tempDir();
    const inner = join(src, "pkg");
    mkdirSync(inner);
    writeFileSync(join(inner, "model.int8.onnx"), "model-bytes");
    writeFileSync(join(inner, "tokens.txt"), "tokens-bytes");
    writeFileSync(join(inner, "README"), "skip me");
    execFileSync("tar", ["-cjf", join(src, "m.tar.bz2"), "-C", src, "pkg"]);
    const archive = readFileSync(join(src, "m.tar.bz2"));
    files.set("/m.tar.bz2", archive);
    const members = (bad = false) => [
      { name: "pkg/model.int8.onnx", path: "model.int8.onnx", sha256: sha(bad ? "other" : "model-bytes") },
      { name: "pkg/tokens.txt", path: "tokens.txt", sha256: sha("tokens-bytes") },
    ];
    const spec = (bad = false): LocalModel => ({
      label: "Test english",
      sizeBytes: archive.length,
      files: [{ url: `${server.url}/m.tar.bz2`, sha256: sha(archive), path: "m.tar.bz2", bytes: archive.length, archive: { members: members(bad) } }],
    });

    LOCAL_MODELS["english-fast"] = spec(true);
    const bad = tempDir();
    await expect(downloadModel("english-fast", { modelDir: bad })).rejects.toBeInstanceOf(ChecksumError);
    expect(readdirSync(bad)).toEqual([]);

    LOCAL_MODELS["english-fast"] = spec();
    const root = tempDir();
    const dir = await downloadModel("english-fast", { modelDir: root });
    expect(readdirSync(dir).sort()).toEqual([".installed.json", "model.int8.onnx", "tokens.txt"]);
    expect(readFileSync(join(dir, "model.int8.onnx"), "utf8")).toBe("model-bytes");
    expect(modelStatus("english-fast", root).installed).toBe(true);
  });

  it("refuses a file larger than its pinned size and leaves no partial folder", async () => {
    pointMultilingualAtServer();
    LOCAL_MODELS.multilingual.files[1].bytes = 100;
    const root = tempDir();
    await expect(downloadModel("multilingual", { modelDir: root })).rejects.toBeInstanceOf(DownloadTooLargeError);
    expect(readdirSync(root)).toEqual([]);
  });

  it("removes its staging folder when cancelled mid-download", async () => {
    const ac = new AbortController();
    const slow = await fakeServer((_req, res) => {
      res.write(Buffer.alloc(1000, 1));
      // Never finishes; the download is cancelled while this is pending.
      setTimeout(() => ac.abort(), 100);
    });
    try {
      LOCAL_MODELS.multilingual = {
        label: "Test multilingual",
        sizeBytes: 0,
        files: [{ url: `${slow.url}/slow`, sha256: sha("x"), path: "encoder.int8.onnx", bytes: 100_000 }],
      };
      const root = tempDir();
      const p = downloadModel("multilingual", { modelDir: root, signal: ac.signal });
      // While it runs, the staging folder exists.
      while (readdirSync(root).length === 0) await new Promise((r) => setTimeout(r, 5));
      expect(readdirSync(root)[0]).toMatch(/^\.multilingual\.partial-/);
      await expect(p).rejects.toMatchObject({ name: "AbortError" });
      expect(readdirSync(root)).toEqual([]);
    } finally {
      await slow.close();
    }
  });

  it("clears staging folders left by a process that died", async () => {
    pointMultilingualAtServer();
    const root = tempDir();
    // A pid that cannot be running (above the kernel's maximum).
    const dead = join(root, ".multilingual.partial-4194305-abcd1234");
    mkdirSync(dead);
    writeFileSync(join(dead, "encoder.int8.onnx"), "half");
    // One belonging to this (live) process stays: it may be a download in progress.
    const live = join(root, `.english-fast.partial-${process.pid}-abcd1234`);
    mkdirSync(live);
    await downloadModel("multilingual", { modelDir: root });
    expect(readdirSync(root).sort()).toEqual([`.english-fast.partial-${process.pid}-abcd1234`, "multilingual"]);
  });

  it("can be cancelled", async () => {
    pointMultilingualAtServer();
    const ac = new AbortController();
    ac.abort();
    const root = tempDir();
    await expect(downloadModel("multilingual", { modelDir: root, signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("transcribeLocal without a model", () => {
  it("never downloads on its own and says how to install", async () => {
    const root = tempDir();
    const err = await transcribeLocal(await audioInput(1), "english-fast", root).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ModelNotInstalledError);
    expect((err as Error).message).toMatch(/English, fast .*not installed.*104 MB download.*clipy models download english-fast/);
    expect(existsSync(join(root, "english-fast"))).toBe(false);
    expect(server.requests).toHaveLength(0);
  });
});

describe("transcribeLocal with a broken model", () => {
  it("fails with a clear error in the child process and leaves this process running", async () => {
    const root = tempDir();
    const dir = join(root, "english-fast");
    mkdirSync(dir);
    writeFileSync(join(dir, "model.int8.onnx"), "not a model");
    writeFileSync(join(dir, "tokens.txt"), "a 0\n");
    writeFileSync(join(dir, ".installed.json"), JSON.stringify({ version: "parakeet-tdt-ctc-110m-en-int8-1" }));
    expect(modelStatus("english-fast", root).installed).toBe(true);
    await expect(transcribeLocal(await audioInput(2), "english-fast", root)).rejects.toThrow(/Local transcription failed/);
  });
});

