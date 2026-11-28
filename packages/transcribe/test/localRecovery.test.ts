import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { audioInput, tempDir } from "./helpers.js";
import { transcribeLocal } from "../src/local.js";

const enginePath = fileURLToPath(new URL("./fixtures/fake-engine.cjs", import.meta.url));

const ENV_KEYS = [
  "CLIPY_FAKE_ENGINE_LOG",
  "CLIPY_FAKE_ENGINE_LOAD",
  "CLIPY_FAKE_ENGINE_CRASH",
  "CLIPY_FAKE_ENGINE_MARKER",
] as const;

function fakeModelDir(): string {
  const root = tempDir();
  const dir = join(root, "english-fast");
  mkdirSync(dir);
  writeFileSync(join(dir, "model.int8.onnx"), "fake");
  writeFileSync(join(dir, "tokens.txt"), "a 0\n");
  writeFileSync(join(dir, ".installed.json"), JSON.stringify({ version: "parakeet-tdt-ctc-110m-en-int8-1" }));
  return root;
}

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("transcribeLocal crash recovery", () => {
  it("records one crashed piece as the only gap and keeps segments from the rest", async () => {
    const dir = tempDir();
    process.env.CLIPY_FAKE_ENGINE_CRASH = "2";
    process.env.CLIPY_FAKE_ENGINE_MARKER = join(dir, "crashed");

    const r = await transcribeLocal(await audioInput(600), "english-fast", fakeModelDir(), enginePath);
    expect(r.gaps).toEqual([
      { startMs: 130_000, endMs: 260_000, reason: "the local model could not transcribe this part" },
    ]);
    expect(r.segments).toHaveLength(4);
    expect(r.segments.map((s) => s.startMs)).toEqual([5000, 262_500, 392_500, 522_500]);
  });

  it("fails when every decode crashes across all pieces", async () => {
    const log = join(tempDir(), "loads.log");
    process.env.CLIPY_FAKE_ENGINE_LOG = log;
    process.env.CLIPY_FAKE_ENGINE_CRASH = "all";

    await expect(transcribeLocal(await audioInput(600), "english-fast", fakeModelDir(), enginePath)).rejects.toThrow(
      "Local transcription failed on every part of this recording.",
    );
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(5);
  });

  it("rejects when the engine throws while loading", async () => {
    const log = join(tempDir(), "loads.log");
    process.env.CLIPY_FAKE_ENGINE_LOG = log;
    process.env.CLIPY_FAKE_ENGINE_LOAD = "throw";

    await expect(transcribeLocal(await audioInput(600), "english-fast", fakeModelDir(), enginePath)).rejects.toThrow(
      "Local transcription failed: the speech model could not be loaded",
    );
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("tries three children and fails when the engine dies while loading", async () => {
    const log = join(tempDir(), "loads.log");
    process.env.CLIPY_FAKE_ENGINE_LOG = log;
    process.env.CLIPY_FAKE_ENGINE_LOAD = "exit";

    await expect(transcribeLocal(await audioInput(600), "english-fast", fakeModelDir(), enginePath)).rejects.toThrow(
      "Local transcription failed on every part of this recording.",
    );
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("reports progress that never decreases and ends at 1", async () => {
    const dir = tempDir();
    process.env.CLIPY_FAKE_ENGINE_CRASH = "2";
    process.env.CLIPY_FAKE_ENGINE_MARKER = join(dir, "crashed");

    const input = await audioInput(600);
    await transcribeLocal(input, "english-fast", fakeModelDir(), enginePath);
    expect(input.progress.length).toBeGreaterThan(1);
    expect(input.progress.every((p, i) => i === 0 || p >= input.progress[i - 1])).toBe(true);
    expect(input.progress[input.progress.length - 1]).toBe(1);
  });
});
