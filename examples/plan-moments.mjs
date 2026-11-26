#!/usr/bin/env node
/**
 * Example: Plan key moments from a sample recording and transcript.
 * Runs rules-based moment detection completely on-device without any network access.
 *
 * Usage:
 *   node examples/plan-moments.mjs
 */
import { planMoments } from "../packages/moments/dist/index.js";

async function main() {
  console.log("Planning key moments from sample interaction data...\n");

  const sample = {
    schemaVersion: 2,
    interactionSelection: "bounded sample; full stream retained locally",
    durationMs: 15000,
    transcript: [
      { startMs: 500, endMs: 2500, text: "let's look at the deployment dashboard" },
      { startMs: 3000, endMs: 4500, text: "click on the deploy button right here" },
      { startMs: 7000, endMs: 9500, text: "and highlight this warning message" },
      { startMs: 11000, endMs: 13000, text: "finally confirm the production roll out" },
    ],
    interactions: [
      // Mouse move and click on 'Deploy' button
      { kind: "move", time_ms: 1000, x: 450, y: 300 },
      { kind: "move", time_ms: 2500, x: 500, y: 350 },
      { kind: "down", time_ms: 3200, x: 500, y: 350, button: 1 },
      { kind: "up", time_ms: 3350, x: 500, y: 350, button: 1 },

      // Flare / Control-key hold to highlight warning
      { kind: "key_down", time_ms: 7200, key_code: 59 }, // Mac Control
      { kind: "move", time_ms: 7500, x: 520, y: 400 },
      { kind: "key_up", time_ms: 9200, key_code: 59 },

      // Confirmation click
      { kind: "down", time_ms: 11500, x: 600, y: 500, button: 1 },
      { kind: "up", time_ms: 11650, x: 600, y: 500, button: 1 },
    ],
    clickElements: [
      { time_ms: 3200, role: "AXButton", label: "Deploy" },
      { time_ms: 11500, role: "AXButton", label: "Confirm Rollout" },
    ],
    capture: {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      output_width: 1920,
      output_height: 1080,
    },
  };

  const result = await planMoments(sample);

  console.log(`Planner Mode: ${result.planner}`);
  console.log(`Planned Moments: ${result.plan.moments.length}\n`);

  for (const moment of result.plan.moments) {
    const timestampSec = (moment.timestamp_ms / 1000).toFixed(2);
    const coords = moment.x != null && moment.y != null ? `at (${moment.x.toFixed(3)}, ${moment.y.toFixed(3)})` : "(no coords)";
    console.log(`- [${timestampSec}s] Source: ${moment.source} ${coords}`);
    console.log(`  Reason: "${moment.reason}"`);
  }
}

main().catch((err) => {
  console.error("Error planning moments:", err);
  process.exit(1);
});
