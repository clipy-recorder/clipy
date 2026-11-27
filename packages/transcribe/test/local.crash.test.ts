import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { LOCAL_CHUNKING, transcribeLocal } from "../src/local.js";
import { audioInput } from "./helpers.js";

const originalChunking = { ...LOCAL_CHUNKING["english-fast"] };

let root: string;
let enginePath: string;
let statePath: string;
let input: Awaited<ReturnType<typeof audioInput>>;
let originalNodeOptions: string | undefined;

const fakeEngine = `
const fs = require("node:fs");

function count() {
  const n = fs.existsSync(process.env.FAKE_STATE)
    ? Number(fs.readFileSync(process.env.FAKE_STATE, "utf8"))
    : 0;
  fs.writeFileSync(process.env.FAKE_STATE, String(n + 1));
  return n + 1;
}

module.exports = {
  OfflineRecognizer: {
    async createAsync() {
      const mode = process.env.FAKE_MODE;

      if (mode === "load-throw") {
        throw new Error("fake load failure");
      }

      if (mode === "load-exit") {
        count();
        process.exit(1);
      }

      return {
        createStream() {
          return {
            acceptWaveform() {},
          };
        },

        async decodeAsync() {
          const n = count();
          const mode = process.env.FAKE_MODE;

          if (mode === "crash-once" && n === 2) {
            process.exit(1);
          }

          if (mode === "crash-every") {
            process.exit(1);
          }

          return {
            text: "fake transcript",
            tokens: [],
            timestamps: [],
          };
        },
      };
    },
  },
};
`;

function setMode(mode: string) {
  process.env.FAKE_MODE = mode;
  process.env.FAKE_STATE = statePath;
  writeFileSync(statePath, "0");
}

function readCount() {
  return Number(readFileSync(statePath, "utf8"));
}

describe("local transcription crash recovery", () => {
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "clipy-crash-test-"));

    const modelsRoot = join(root, "models");
    const modelDir = join(modelsRoot, "english-fast");
    mkdirSync(modelDir, { recursive: true });

    writeFileSync(join(modelDir, "model.int8.onnx"), "fake model");
    writeFileSync(join(modelDir, "tokens.txt"), "fake tokens");
    writeFileSync(
      join(modelDir, ".installed.json"),
      JSON.stringify({
        model: "english-fast",
        version: "parakeet-tdt-ctc-110m-en-int8-1",
      }),
    );

    enginePath = join(root, "fake-engine.cjs");
    statePath = join(root, "state.txt");
    writeFileSync(enginePath, fakeEngine);
    writeFileSync(statePath, "0");

    input = await audioInput(6);

    // Make the six-second test audio into three two-second pieces.
    LOCAL_CHUNKING["english-fast"] = {
      targetSec: 2,
      maxSec: 2,
      overlapSec: 0,
      minSec: 0.5,
    };

    // Node 22.15 needs this flag to execute the TypeScript worker.
    originalNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = [
      originalNodeOptions,
      "--experimental-strip-types",
    ]
      .filter(Boolean)
      .join(" ");
  });

  afterEach(() => {
    LOCAL_CHUNKING["english-fast"] = originalChunking;

    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions;
    }

    delete process.env.FAKE_MODE;
    delete process.env.FAKE_STATE;

    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(input.wavPath), { recursive: true, force: true });
  });

  it("keeps only the crashed piece as a gap and recovers the remaining pieces", async () => {
    setMode("crash-once");

    const result = await transcribeLocal(
      input,
      "english-fast",
      join(root, "models"),
      enginePath,
    );

    expect(result.segments).toHaveLength(2);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].startMs).toBeGreaterThanOrEqual(2000);
    expect(result.gaps[0].startMs).toBeLessThan(4000);
  });

  it("fails when every piece crashes", async () => {
    setMode("crash-every");

    await expect(
      transcribeLocal(input, "english-fast", join(root, "models"), enginePath),
    ).rejects.toThrow(
      "Local transcription failed on every part of this recording.",
    );
  });

  it("returns an error when the engine throws while loading", async () => {
    setMode("load-throw");

    await expect(
      transcribeLocal(input, "english-fast", join(root, "models"), enginePath),
    ).rejects.toThrow(
      "Local transcription failed: the speech model could not be loaded: fake load failure",
    );
  });

  it("retries three child processes when the engine dies during loading", async () => {
    setMode("load-exit");

    await expect(
      transcribeLocal(input, "english-fast", join(root, "models"), enginePath),
    ).rejects.toThrow(
      "Local transcription failed on every part of this recording.",
    );

    expect(readCount()).toBe(3);
  });

  it("keeps progress non-decreasing and finishes at 100 percent", async () => {
    setMode("success");

    const result = await transcribeLocal(
      input,
      "english-fast",
      join(root, "models"),
      enginePath,
    );

    expect(result.segments).toHaveLength(3);
    expect(input.progress.length).toBeGreaterThan(0);

    for (let i = 1; i < input.progress.length; i++) {
      expect(input.progress[i]).toBeGreaterThanOrEqual(input.progress[i - 1]);
    }

    expect(input.progress[input.progress.length - 1]).toBe(1);
  });
});
