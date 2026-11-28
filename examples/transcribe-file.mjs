#!/usr/bin/env node
/**
 * Example: Inspect local model status and demonstrate transcription workflow.
 *
 * Usage:
 *   node examples/transcribe-file.mjs [path-to-media-file]
 */
import { existsSync } from "node:fs";
import { defaultModelDir, LOCAL_MODELS, modelStatus, transcribe } from "../packages/transcribe/dist/index.js";

async function main() {
  const mediaFile = process.argv[2];
  const modelDir = defaultModelDir();

  console.log("Clipy Transcription on Local Machine");
  console.log(`Models directory: ${modelDir}\n`);

  console.log("Available On-Device Models:");
  for (const [id, model] of Object.entries(LOCAL_MODELS)) {
    const status = modelStatus(id, modelDir);
    const sizeMb = (model.sizeBytes / (1024 * 1024)).toFixed(1);
    console.log(`- ${id} (${model.label}): ${status.installed ? "INSTALLED" : "NOT DOWNLOADED"} (${sizeMb} MB)`);
  }

  if (!mediaFile) {
    console.log("\nNo media file specified. Pass a file path to run transcription:");
    console.log("  node examples/transcribe-file.mjs sample.mp4");
    return;
  }

  if (!existsSync(mediaFile)) {
    console.error(`\nFile not found: ${mediaFile}`);
    process.exit(1);
  }

  console.log(`\nTranscribing: ${mediaFile}`);
  const result = await transcribe(mediaFile, {
    kind: "none", // Fast dry run / fallback mode without requiring installed on-device models
  });

  console.log(`Segments: ${result.segments.length}`);
  console.log(`Gaps: ${result.gaps.length}`);
  for (const gap of result.gaps) {
    console.log(`Gap: [${gap.startMs}ms - ${gap.endMs}ms] ${gap.reason}`);
  }
}

main().catch((err) => {
  console.error("Transcription error:", err);
  process.exit(1);
});
