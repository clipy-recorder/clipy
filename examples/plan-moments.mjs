// Plans the key moments of a sample screen recording with the rules-only
// planner: no model provider, no network, no API key.
//
// Run it from the repository root:
//   pnpm build
//   node examples/plan-moments.mjs

import { readFile } from "node:fs/promises";
import { planMoments } from "../packages/moments/dist/index.js";

const fixtureUrl = new URL("../packages/moments/test/fixtures/flare-sample.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));

// The planner's input schema is strict, so keep only the fields it knows.
// The sample's events carry extra fields such as cursor_type.
const EVENT_FIELDS = ["kind", "time_ms", "x", "y", "button", "key_code", "delta_x", "delta_y", "active"];
const interactions = fixture.events.map((event) =>
  Object.fromEntries(EVENT_FIELDS.filter((key) => key in event).map((key) => [key, event[key]])),
);

// Build the planner input the way packages/moments/test/planMoments.test.ts does.
const { x, y, width, height, output_width, output_height } = fixture.capture;
const input = {
  schemaVersion: 2,
  durationMs: fixture.durationMs,
  transcript: fixture.transcript,
  interactions,
  clickElements: fixture.click_elements,
  interactionSelection: "bounded sample; full stream retained locally",
  capture: { x, y, width, height, output_width, output_height },
};

// No provider option: only the rules run, so nothing leaves this machine.
const { plan, planner } = await planMoments(input);
if (!("schemaVersion" in plan)) throw new Error("Expected a version 2 plan");

// 20223 ms becomes 00:20.223
function clock(ms) {
  const total = Math.round(ms);
  const minutes = String(Math.floor(total / 60000)).padStart(2, "0");
  const seconds = String(Math.floor((total % 60000) / 1000)).padStart(2, "0");
  const millis = String(total % 1000).padStart(3, "0");
  return `${minutes}:${seconds}.${millis}`;
}

const moments = [...plan.moments].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
console.log(`Planner: ${planner}, ${moments.length} moments`);
for (const moment of moments) {
  console.log(`${clock(moment.timestamp_ms)}  ${moment.source.padEnd(6)}  ${moment.reason}`);
}