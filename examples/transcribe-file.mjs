#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import {
  transcribe,
  downloadModel,
  modelStatus,
  LOCAL_MODELS,
} from "../packages/transcribe/dist/index.js";

const args = process.argv.slice(2);
const noTranscription = args.includes("--none");
const inputPath = args.find((arg) => !arg.startsWith("--"));

if (!inputPath || args.some((arg) => arg !== "--none" && arg.startsWith("--"))) {
  console.error("Usage: node examples/transcribe-file.mjs <audio-or-video-file> [--none]");
  process.exit(1);
}

const filePath = resolve(inputPath);

try {
  if (noTranscription) {
    const result = await transcribe(filePath, { kind: "none" });
    console.log("Transcription disabled.");
    for (const gap of result.gaps) {
      console.log(`[${formatTime(gap.startMs)} - ${formatTime(gap.endMs)}] ${gap.reason}`);
    }
  } else {
    const model = "english-fast";
    const status = modelStatus(model);

    if (!status.installed) {
      const spec = LOCAL_MODELS[model];
      const readline = createInterface({ input: stdin, output: stdout });

      try {
        const answer = await readline.question(
          `${spec.label} requires a ${Math.round(spec.sizeBytes / 1_000_000)} MB download. Continue? (y/N): `,
        );

        if (!["y", "yes"].includes(answer.trim().toLowerCase())) {
          console.log("Download cancelled.");
          process.exitCode = 0;
          process.exit();
        }
      } finally {
        readline.close();
      }

      console.log("Downloading speech model...");
      await downloadModel(model, {
        onProgress: (fraction) => {
          const percent = Math.round(fraction * 100);
          stdout.write(`\rDownload progress: ${percent}%`);
          if (fraction === 1) stdout.write("\n");
        },
      });
    }

    console.log("Transcribing file...");
    const result = await transcribe(filePath, {
      kind: "local",
      model,
    });

    if (result.segments.length === 0) {
      console.log("No speech segments found.");
    }

    for (const segment of result.segments) {
      console.log(
        `[${formatTime(segment.startMs)} - ${formatTime(segment.endMs)}] ${segment.text}`,
      );
    }

    for (const gap of result.gaps) {
      console.log(
        `[${formatTime(gap.startMs)} - ${formatTime(gap.endMs)}] Gap: ${gap.reason}`,
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Transcription failed.");
  process.exitCode = 1;
}

function formatTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = milliseconds % 1000;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
