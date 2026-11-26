#!/usr/bin/env node
/**
 * Example: Inspect capture sources and demonstrate virtual display setup on Linux.
 *
 * Usage:
 *   node examples/record-virtual-display.mjs
 */
import { checkCapture, listSources, startVirtualDisplay } from "../packages/capture/dist/index.js";

async function main() {
  console.log("Clipy Capture System & Virtual Display Example\n");

  // 1. Check system capture prerequisites
  const check = await checkCapture();
  console.log(`Platform: ${check.platform}`);
  console.log(`Prerequisites OK: ${check.ok}`);
  if (check.ffmpeg) {
    console.log(`FFmpeg: ${check.ffmpeg}`);
  }
  if (check.problems.length > 0) {
    console.log(`Problems: ${check.problems.join("; ")}`);
  }
  if (check.hints.length > 0) {
    console.log(`Hints: ${check.hints.join("; ")}`);
  }

  // 2. List available screen/window capture sources
  try {
    const sources = await listSources();
    console.log(`\nFound ${sources.length} capture source(s):`);
    for (const src of sources) {
      console.log(`- [${src.id}] (${src.kind}): "${src.name}" (${src.width ?? "?"}x${src.height ?? "?"})`);
    }
  } catch (err) {
    console.log("Could not list sources:", err.message);
  }

  // 3. Virtual Display (Linux only)
  if (process.platform === "linux") {
    console.log("\nStarting private Xvfb virtual display (1280x720)...");
    try {
      const vDisplay = await startVirtualDisplay({ width: 1280, height: 720 });
      console.log(`Virtual display created on: ${vDisplay.display} (PID: ${vDisplay.pid})`);
      console.log(`Xauthority file: ${vDisplay.xauthority ?? "none"}`);
      if (vDisplay.warnings.length > 0) {
        console.log(`Warnings: ${vDisplay.warnings.join("; ")}`);
      }

      console.log("Stopping virtual display...");
      await vDisplay.stop();
      console.log("Virtual display cleaned up successfully.");
    } catch (err) {
      console.error("Could not start virtual display:", err.message);
    }
  } else {
    console.log(`\nVirtual display (Xvfb) is supported on Linux (current OS is ${process.platform}).`);
    console.log("On macOS and Windows, direct desktop and window capture are used instead.");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
