import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveThreads, transcribe } from "../src/index.js";
import { recognizerConfig } from "../src/local.js";
import { audioInput, tempDir } from "./helpers.js";
import { transcribeLocal } from "../src/local.js";

describe("resolveThreads", () => {
  it("defaults to max(1, min(4, floor(available / 2)))", () => {
    expect(resolveThreads(undefined, 1)).toBe(1);
    expect(resolveThreads(undefined, 2)).toBe(1);
    expect(resolveThreads(undefined, 4)).toBe(2);
    expect(resolveThreads(undefined, 8)).toBe(4);
    expect(resolveThreads(undefined, 16)).toBe(4);
  });

  it("accepts explicit integer counts from 1 to available", () => {
    expect(resolveThreads(1, 8)).toBe(1);
    expect(resolveThreads(6, 8)).toBe(6);
    expect(resolveThreads(8, 8)).toBe(8);
    const hostMax = Math.max(1, availableParallelism());
    expect(resolveThreads(hostMax)).toBe(hostMax);
  });

  it("rejects out-of-range and non-integer thread counts", () => {
    expect(() => resolveThreads(0, 8)).toThrow(/threads must be an integer from 1 to 8/);
    expect(() => resolveThreads(-2, 8)).toThrow(/threads must be an integer from 1 to 8/);
    expect(() => resolveThreads(9, 8)).toThrow(/threads must be an integer from 1 to 8/);
    expect(() => resolveThreads(2.5, 8)).toThrow(/threads must be an integer from 1 to 8/);
    expect(() => resolveThreads(Number.NaN, 8)).toThrow(/threads must be an integer from 1 to 8/);
  });
});

describe("recognizerConfig", () => {
  it("passes numThreads to both local model configs", () => {
    const parakeet = recognizerConfig("english-fast", "/tmp/models", 6) as { modelConfig: { numThreads: number } };
    const whisper = recognizerConfig("multilingual", "/tmp/models", 3) as { modelConfig: { numThreads: number } };
    expect(parakeet.modelConfig.numThreads).toBe(6);
    expect(whisper.modelConfig.numThreads).toBe(3);
  });
});

describe("threads validation before starting", () => {
  it("rejects invalid threads in transcribe before probing or extracting", async () => {
    const stages: string[] = [];
    await expect(
      transcribe(
        "/nonexistent/missing-recording.mp4",
        { kind: "local", model: "english-fast" },
        { threads: 0, onProgress: (p) => stages.push(p.stage) },
      ),
    ).rejects.toThrow(/threads must be an integer from 1 to/);
    expect(stages).toEqual([]);
  });

  it("rejects invalid threads in transcribeLocal before checking the model", async () => {
    const tooMany = Math.max(1, availableParallelism()) + 1;
    await expect(transcribeLocal(await audioInput(1), "english-fast", tempDir(), undefined, tooMany)).rejects.toThrow(
      /threads must be an integer from 1 to/,
    );
  });
});
