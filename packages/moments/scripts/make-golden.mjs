#!/usr/bin/env node
/**
 * Writes the golden files the Rust port of the moment planner is tested
 * against (desktop/src-tauri/crates/clipy-local-moments/tests/golden/).
 *
 * Every case is run through the TypeScript `planMoments`:
 * - rules only (no provider), always;
 * - with a stubbed model when the case lists spoken cues: a local
 *   OpenAI-compatible server answers with those cues, and the exact request
 *   body the planner sent is recorded, so the Rust client can be checked
 *   byte for byte.
 *
 * One case carries a capture timeline. The planner input has no field for it
 * (the hosted endpoint never received one), so that case runs through
 * `rulesWithTimeline` below, which repeats planLocalMoments' rules-only path
 * with the timeline passed to the detector. The script first checks that the
 * same function gives exactly `planMoments`' output on every other case.
 *
 * All inputs are synthetic: invented words, labels and pointer paths, and the
 * synthetic flare sample in test/fixtures. Deterministic: re-running it writes
 * the same files.
 *
 *   node packages/moments/scripts/make-golden.mjs [crate-dir]
 *
 * Run it from the workspace root (the folder with pnpm-workspace.yaml), after
 * `pnpm install` there. It regenerates src/generated (a no-op outside the
 * monorepo) and compiles the package first. Then run `cargo test` in the crate.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const oss = join(pkg, "..", "..");
const repo = join(oss, "..");
const CRATE = ["desktop", "src-tauri", "crates", "clipy-local-moments"];
// The monorepo keeps oss/ beside desktop/; the exported repo has both at its root.
const crate = process.argv[2]
  ? resolve(process.argv[2])
  : [join(repo, ...CRATE), join(oss, ...CRATE)].find((dir) => existsSync(join(dir, "Cargo.toml")));
if (!crate) {
  process.stderr.write("[golden] crate not found; pass its directory as the first argument\n");
  process.exit(2);
}
const OUT = join(crate, "tests", "golden");

execFileSync(process.execPath, [join(oss, "scripts", "sync-from-monorepo.mjs")], { stdio: "inherit" });
const tsc = createRequire(join(pkg, "package.json")).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(pkg, "tsconfig.json")], { stdio: "inherit" });

const { planMoments } = await import(join(pkg, "dist", "index.js"));
const { buildCursorEvidenceFromTrack, captureRectAt, normalizeClick } = await import(
  join(pkg, "dist", "generated", "keyMomentsCursorContext.js")
);
const { fuseMoments } = await import(join(pkg, "dist", "generated", "keyMomentsFusion.js"));
const { LOCAL_SPOKEN_MOMENTS_MAX, LOCAL_GESTURE_MOMENTS_MAX, LOCAL_V2_MOMENTS_MAX } = await import(
  join(pkg, "dist", "generated", "localMomentPlan.js")
);

const SELECTION = "bounded sample; full stream retained locally";

// ---------------------------------------------------------------------------
// Builders for synthetic inputs.

function recorder() {
  const events = [];
  const clickElements = [];
  let at = { x: 0, y: 0 };
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const api = {
    events,
    clickElements,
    at: (x, y) => {
      at = { x, y };
      return api;
    },
    move(t, x, y) {
      at = { x, y };
      events.push({ kind: "move", time_ms: r3(t), x, y });
      return api;
    },
    /** Straight line from the current position to (x, y), one sample every `step` ms. */
    glide(t0, t1, x, y, step = 30) {
      const from = { ...at };
      for (let t = t0 + step; t < t1; t += step) {
        const f = (t - t0) / (t1 - t0);
        const px = Math.round(from.x + (x - from.x) * f);
        const py = Math.round(from.y + (y - from.y) * f);
        if (px === at.x && py === at.y) continue;
        api.move(t, px, py);
      }
      if (at.x !== x || at.y !== y) api.move(t1, x, y);
      return api;
    },
    /** Pointer resting at the current spot: sub-pixel jitter samples every `step` ms. */
    rest(t0, t1, step = 250) {
      const base = { ...at };
      let flip = 0;
      for (let t = t0; t <= t1; t += step) {
        flip ^= 1;
        events.push({ kind: "move", time_ms: r3(t), x: base.x + flip, y: base.y });
      }
      at = { x: base.x + flip, y: base.y };
      return api;
    },
    click(t, label = null, role = "AXButton", opts = {}) {
      const button = opts.button ?? 1;
      events.push({ kind: "down", time_ms: r3(t), x: at.x, y: at.y, button });
      if (label !== undefined && opts.element !== false) clickElements.push({ time_ms: r3(t + (opts.labelOffset ?? 0)), role, label });
      if (opts.up !== false) events.push({ kind: "up", time_ms: r3(t + (opts.hold ?? 80)), x: at.x, y: at.y, button });
      return api;
    },
    key(t, code, kind) {
      events.push({ kind, time_ms: r3(t), key_code: code });
      return api;
    },
    hold(t0, t1, code = 59) {
      api.key(t0, code, "key_down");
      api.key(t1, code, "key_up");
      return api;
    },
    annotation(t, active) {
      events.push({ kind: "annotation", time_ms: r3(t), active });
      return api;
    },
    scroll(t0, t1, x, y, dy, step = 50) {
      for (let t = t0; t <= t1; t += step) events.push({ kind: "scroll", time_ms: r3(t), x, y, delta_x: 0, delta_y: dy });
      return api;
    },
    done() {
      events.sort((a, b) => a.time_ms - b.time_ms);
      return { interactions: events, clickElements };
    },
  };
  return api;
}

/** Word-level transcript: `text` spread over `ms` from `start`. */
function utterance(start, ms, text) {
  const words = text.split(" ");
  const each = ms / words.length;
  return words.map((word, i) => ({
    startMs: Math.round(start + each * i),
    endMs: Math.round(start + each * (i + 1) - 10),
    text: word,
  }));
}

function input({ durationMs, transcript = [], interactions = [], clickElements = [], capture }) {
  const out = { schemaVersion: 2, durationMs, transcript, interactions, clickElements, interactionSelection: SELECTION };
  if (capture) out.capture = capture;
  return out;
}

const SCREEN = { x: 0, y: 0, width: 1440, height: 900, output_width: 1440, output_height: 900 };

// ---------------------------------------------------------------------------
// Cases.

const cases = [];

// 1. The synthetic flare sample from the package's own tests.
{
  const fixture = JSON.parse(readFileSync(join(pkg, "test", "fixtures", "flare-sample.json"), "utf8"));
  const events = fixture.events.map((e) => {
    const out = {};
    for (const key of ["kind", "time_ms", "x", "y", "button", "key_code", "delta_x", "delta_y", "active"]) {
      if (key in e) out[key] = e[key];
    }
    return out;
  });
  const { x, y, width, height, output_width, output_height } = fixture.capture;
  cases.push({
    name: "flare-sample",
    description: "The synthetic flare sample from test/fixtures: clicks, scrolls, a hold-Control highlight, speech.",
    input: input({
      durationMs: fixture.durationMs,
      transcript: fixture.transcript,
      interactions: events,
      clickElements: fixture.click_elements,
      capture: { x, y, width, height, output_width, output_height },
    }),
    cues: fixture.llmMoments,
  });
}

// 2. Clicks only: clusters, labels, a click outside the picture, no speech.
{
  const r = recorder().at(200, 200);
  r.click(1000, "Save", "AXButton");
  r.click(1300, "Save", "AXButton"); // same spot, same label: one cluster of 2
  r.move(1350, 210, 205).click(1400, null, "AXButton"); // within radius, unlabeled: joins
  r.glide(1500, 2500, 700, 400).click(2600, "  Open   the\n settings\tpanel  ", "AXButton");
  r.move(2700, 702, 401).click(2800, "Other label", "AXButton"); // same spot, different label: new cluster
  r.at(900, 600).click(4000, "x".repeat(120), "AXStaticText"); // label cut to 80
  r.at(2000, 600).click(5000, "Off screen", "AXButton"); // outside the 1440 wide capture
  r.at(300, 800).click(6000, "Right click", "AXButton", { button: 2 });
  r.at(310, 805).click(6050, "Late label", "AXButton", { labelOffset: 40 }); // label within 50 ms
  r.at(500, 500).click(7000, "", "AXButton"); // empty label reads as none
  r.at(520, 520).click(9000, "No up", "AXButton", { up: false });
  cases.push({
    name: "clicks-only",
    description: "Click clusters, element labels (whitespace, length, timing), a click outside the capture, no transcript.",
    input: input({ durationMs: 10_000, ...r.done(), capture: SCREEN }),
  });
}

// 3. Pointer rests only, with narration (long narration gets the ellipsis).
{
  const r = recorder().at(100, 100);
  r.rest(0, 2600); // 2.6 s rest
  r.glide(2600, 3400, 800, 300);
  r.rest(3400, 4400); // 1 s rest: a dwell, too short to stand alone
  r.glide(4400, 5200, 400, 700);
  r.rest(5200, 7450); // 2.25 s: "2.3s" in JavaScript
  r.glide(7450, 8000, 1200, 200, 20); // fast, mid-flight
  r.rest(8000, 12_000);
  r.glide(12_000, 12_400, 3000, 3000); // out of the picture
  r.rest(12_400, 15_000);
  const transcript = [
    ...utterance(500, 3000, "first I want to look at this part of the page which shows the current state of every job in the queue right now"),
    ...utterance(9000, 1000, "and here"),
  ];
  cases.push({
    name: "rests-only",
    description: "Pointer rests of different lengths, a fast glide, a rest outside the picture, narration over 110 characters.",
    input: input({ durationMs: 16_000, transcript, ...r.done(), capture: SCREEN }),
  });
}

// 4. Drawings: pen toggled by hand, strokes grouped, a span overlapping a flare.
{
  const r = recorder().at(300, 300);
  r.annotation(1000, true);
  r.click(1200, undefined, "", { element: false, up: false }); // pen down (no label entry)
  r.glide(1200, 1700, 500, 350).events.push({ kind: "up", time_ms: 1700, x: 500, y: 350, button: 1 });
  r.at(520, 360).events.push({ kind: "down", time_ms: 2500, x: 520, y: 360, button: 1 });
  r.glide(2500, 2900, 560, 420).events.push({ kind: "up", time_ms: 2900, x: 560, y: 420, button: 1 });
  r.events.push({ kind: "down", time_ms: 3000, x: 560, y: 420, button: 2 }); // secondary button: no stroke
  r.events.push({ kind: "up", time_ms: 3100, x: 560, y: 420, button: 2 });
  r.at(900, 600).events.push({ kind: "down", time_ms: 7000, x: 900, y: 600, button: 1 }); // separate group
  r.events.push({ kind: "up", time_ms: 7050, x: 900, y: 600, button: 1 }); // a dot
  r.annotation(8000, false);
  // A Control hold also flips the overlay on: that span is the flare, not a drawing.
  r.annotation(10_000, true).hold(10_000, 11_500).at(700, 700);
  r.events.push({ kind: "down", time_ms: 10_500, x: 700, y: 700, button: 1 });
  r.events.push({ kind: "up", time_ms: 10_700, x: 710, y: 700, button: 1 });
  r.annotation(11_500, false);
  // Open at the end of the take: closed at durationMs.
  r.annotation(13_000, true).at(100, 800);
  r.events.push({ kind: "down", time_ms: 13_200, x: 100, y: 800, button: 1 });
  r.move(13_300, 140, 820);
  r.events.push({ kind: "up", time_ms: 13_400, x: 160, y: 830, button: 1 });
  r.events.push({ kind: "down", time_ms: 14_000, x: 2000, y: 2000, button: 1 }); // outside the picture
  r.events.push({ kind: "up", time_ms: 14_100, x: 2100, y: 2000, button: 1 });
  const transcript = utterance(2000, 1500, "look at this circle");
  cases.push({
    name: "drawings",
    description: "Pen strokes drawn with the overlay on by hand: grouping, a secondary button, a flare-owned span, an open span, an off-picture stroke.",
    input: input({ durationMs: 15_000, transcript, ...r.done(), capture: SCREEN }),
  });
}

// 5. Flares and Control chords.
{
  const r = recorder().at(400, 400);
  r.move(500, 400, 400);
  r.hold(1000, 2500); // plain flare, cursor parked: position from the last sample
  r.key(4000, 59, "key_down").key(4300, 8, "key_down").key(4350, 8, "key_up").key(4600, 59, "key_up"); // Ctrl+C: not a flare
  r.key(6000, 62, "key_down").key(6100, 56, "key_down").key(6200, 56, "key_up").key(7600, 62, "key_up"); // right Control + Shift: a flare
  r.hold(9000, 9100); // under the grace: nothing
  r.hold(10_000, 10_400); // 280 ms after grace: below the standalone minimum
  r.glide(11_900, 13_800, 900, 500);
  r.hold(12_000, 13_900); // sweeping flare
  r.key(15_000, 59, "key_down").key(15_200, 59, "key_down").key(16_000, 59, "key_up"); // repeat down
  r.key(17_000, 59, "key_up"); // stray up
  const transcript = utterance(20_000, 1000, "that is all");
  cases.push({
    name: "flares-chords",
    description: "Hold-Control flares: parked, sweeping, right Control with Shift, a Ctrl+C chord, a tap under the grace, a short hold.",
    input: input({ durationMs: 22_000, transcript, ...r.done(), capture: SCREEN }),
  });
}

// 6. No capture geometry: positions are never reported, pen strokes are dropped.
{
  const r = recorder().at(400, 300);
  r.rest(0, 2500).click(2600, "Submit", "AXButton");
  r.hold(4000, 5500);
  r.annotation(7000, true);
  r.events.push({ kind: "down", time_ms: 7100, x: 400, y: 300, button: 1 });
  r.events.push({ kind: "up", time_ms: 7300, x: 450, y: 300, button: 1 });
  r.annotation(7500, false);
  const transcript = utterance(2000, 1500, "press submit now");
  cases.push({
    name: "no-capture",
    description: "No capture geometry: moments keep their timing, never coordinates.",
    input: input({ durationMs: 9000, transcript, ...r.done() }),
    cues: [{ timestamp_ms: 2000, reason: "The speaker asks to press submit." }],
  });
}

// 7. A window that moves during the take (capture timeline).
{
  const r = recorder().at(150, 150);
  r.click(1000, "Left", "AXButton");
  r.at(1650, 200).click(5000, "Moved", "AXButton"); // inside the window's later position only
  r.at(1650, 200).rest(6000, 8600);
  r.at(100, 120).click(9000, "Gone", "AXButton"); // inside the first position only
  const captureTimeline = [
    { time_ms: 0, x: 0, y: 0, width: 800, height: 600 },
    { time_ms: 4000, x: 1200, y: 100, width: 800, height: 600 },
  ];
  cases.push({
    name: "moving-timeline",
    description: "Window-following capture: the capture timeline moves the picture at 4 s.",
    input: input({
      durationMs: 10_000,
      ...r.done(),
      capture: { x: 0, y: 0, width: 800, height: 600, output_width: 1600, output_height: 1200 },
    }),
    captureTimeline,
  });
}

// 8. Empty interactions, transcript only.
{
  const transcript = [
    ...utterance(1000, 2000, "this report has a typo"),
    ...utterance(5000, 2000, "and this chart is wrong"),
  ];
  cases.push({
    name: "transcript-only",
    description: "No interactions at all: rules find nothing, spoken cues stand alone.",
    input: input({ durationMs: 8000, transcript, capture: SCREEN }),
    cues: [
      { timestamp_ms: 5000, reason: "  The chart is wrong.  " },
      { timestamp_ms: 1000, reason: "The report has a typo." },
      { timestamp_ms: 1000, reason: "Duplicate timestamp, dropped." },
    ],
    fenced: true,
  });
}

// 9. Caps exceeded.
{
  const r = recorder();
  for (let i = 0; i < 40; i++) {
    r.at(50 + (i % 10) * 120, 50 + Math.floor(i / 10) * 150).click(500 + i * 1000, `Item ${i}`, "AXCell");
  }
  for (let i = 0; i < 40; i++) {
    r.at(100 + (i % 8) * 150, 700).hold(41_000 + i * 1500, 41_000 + i * 1500 + 600 + (i % 5) * 100);
    r.move(41_000 + i * 1500 + 10, 100 + (i % 8) * 150, 700);
  }
  for (let i = 0; i < 20; i++) {
    r.at(1300, 100 + i * 30).rest(102_000 + i * 3000, 102_000 + i * 3000 + 2000 + (i % 4) * 200);
  }
  const transcript = [];
  for (let i = 0; i < 32; i++) transcript.push(...utterance(170_000 + i * 900, 800, `point ${i}`));
  const cues = [];
  for (let i = 0; i < 30; i++) cues.push({ timestamp_ms: 170_000 + i * 900, reason: `Spoken point ${i}.` });
  cases.push({
    name: "caps-exceeded",
    description: "40 clicks, 40 flares, 20 rests and 30 spoken cues: every cap and the gesture ceiling apply.",
    input: input({ durationMs: 200_000, transcript, ...r.done(), capture: SCREEN }),
    cues,
  });
}

// 10. Speech fused to clicks: before, after, and two cues wanting one click.
{
  const r = recorder().at(600, 400);
  r.click(3000, "Deploy", "AXButton");
  r.at(200, 700).click(9500, "Cancel", "AXButton");
  r.at(1000, 200).click(15_000, "Settings", "AXButton");
  r.at(1100, 250).click(30_000, "Far away", "AXButton");
  const transcript = [
    ...utterance(2000, 1200, "click this button"),
    ...utterance(11_000, 1200, "then that one"),
    ...utterance(13_000, 1000, "this one"),
    ...utterance(14_000, 800, "or this"),
  ];
  cases.push({
    name: "speech-fused-click",
    description: "Spoken cues fused to clicks: best-first assignment, a cue that loses its click, a click nobody mentions.",
    input: input({ durationMs: 32_000, transcript, ...r.done(), capture: SCREEN }),
    cues: [
      { timestamp_ms: 14_000, reason: "Or this one." },
      { timestamp_ms: 2000, reason: "Click this button." },
      { timestamp_ms: 11_000, reason: "Then that one." },
      { timestamp_ms: 13_000, reason: "This one." },
    ],
  });
}

// 11. Speech near a flare, a drawing, a rest, and a moving cursor.
{
  const r = recorder().at(500, 500);
  r.move(100, 500, 500);
  r.glide(2000, 4000, 900, 300);
  r.hold(2100, 4100); // flare containing the first cue
  r.annotation(8000, true);
  r.at(300, 300).events.push({ kind: "down", time_ms: 8200, x: 300, y: 300, button: 1 });
  r.glide(8200, 8800, 400, 400).events.push({ kind: "up", time_ms: 8800, x: 400, y: 400, button: 1 });
  r.annotation(9000, false);
  r.at(1000, 700).rest(14_000, 17_000);
  r.glide(17_000, 23_000, 100, 100, 20); // moving the whole time
  r.at(100, 100).rest(29_500, 32_000);
  const transcript = [
    ...utterance(3000, 1000, "this line here"),
    ...utterance(8500, 1000, "and this area"),
    ...utterance(15_000, 1000, "this panel"),
    ...utterance(20_000, 1000, "somewhere over there"),
    ...utterance(26_000, 1000, "and this"),
  ];
  cases.push({
    name: "speech-near-gestures",
    description: "Spoken cues anchored to a flare, a drawing, a rest, a moving cursor (no anchor) and a rest just after the cue.",
    input: input({ durationMs: 33_000, transcript, ...r.done(), capture: SCREEN }),
    cues: [
      { timestamp_ms: 3000, reason: "The speaker highlights the line." },
      { timestamp_ms: 8500, reason: "The speaker draws around the area." },
      { timestamp_ms: 15_000, reason: "The speaker points at the panel." },
      { timestamp_ms: 20_000, reason: "The speaker points somewhere." },
      { timestamp_ms: 26_000, reason: "The speaker points again." },
    ],
  });
}

// 12. Text and number edge cases: UTF-16 slicing, rounding ties.
{
  const r = recorder().at(1, 1);
  r.click(1000, `${"\u{1F600}".repeat(50)} label`, "AXButton"); // 80 code units cut inside the emoji run
  r.at(16, 16).rest(3000, 5250); // 2.25 s rest at 16/32 = 0.5
  r.at(1, 30).hold(7000, 8250);
  const long = `${"é".repeat(60)} ${"\u{1F680}".repeat(40)} end`;
  const transcript = [
    { startMs: 900, endMs: 1500, text: ` ${long} ` },
    { startMs: 3000, endMs: 3500, text: "﻿word " },
  ];
  cases.push({
    name: "text-edges",
    description: "Non-BMP labels and narration (UTF-16 slicing), JavaScript whitespace, toFixed rounding ties.",
    input: input({
      durationMs: 9000,
      transcript,
      ...r.done(),
      capture: { x: 0, y: 0, width: 32, height: 32, output_width: 32, output_height: 32 },
    }),
    cues: [{ timestamp_ms: 900, reason: `${"\u{1F680}".repeat(10)} rocket` }],
  });
}

// 13. Two labels cut to 80 units through different emoji. JavaScript keeps the
// two different lone surrogates, so the clicks stay apart.
{
  const r = recorder().at(1, 1);
  r.click(100, `${"a".repeat(79)}\u{1F600}`, "AXButton", { up: false });
  r.click(200, `${"a".repeat(79)}\u{1F9ED}`, "AXButton", { up: false });
  cases.push({
    name: "split-surrogate-labels",
    description: "Two nearby clicks whose labels differ only in the emoji the 80-unit cut splits.",
    input: input({ durationMs: 1000, ...r.done() }),
  });
}

// ---------------------------------------------------------------------------
// Running.

/** planLocalMoments' rules-only path, with a capture timeline passed to the detector. */
function rulesWithTimeline(inp, captureTimeline) {
  const frameWidth = inp.capture?.output_width ?? null;
  const frameHeight = inp.capture?.output_height ?? null;
  const evidence = buildCursorEvidenceFromTrack(
    { events: inp.interactions, click_elements: inp.clickElements, capture: inp.capture ?? null, capture_timeline: captureTimeline },
    { durationMs: inp.durationMs, frameWidth, frameHeight, sourcePlatform: "mac" },
  );
  const coordsTrusted = evidence.captureRect !== null;
  const fused = fuseMoments({
    deixis: [],
    clicks: evidence.clicks,
    moves: evidence.moves,
    hovers: evidence.hovers,
    flares: evidence.flares,
    strokes: evidence.penStrokes,
    segments: inp.transcript.map((s) => ({ start: s.startMs / 1000, end: s.endMs / 1000, text: s.text })),
    durationMs: inp.durationMs,
    maxMoments: LOCAL_SPOKEN_MOMENTS_MAX,
    maxAnnotationMoments: LOCAL_GESTURE_MOMENTS_MAX,
    normalizeAt: coordsTrusted
      ? (x, y, tMs) => normalizeClick(x, y, frameWidth, frameHeight, captureRectAt(evidence.captureRect, evidence.captureTimeline, tMs))
      : (x, y) => ({ x, y }),
  });
  const moments = fused
    .map((m) => {
      const moment = {
        timestamp_ms: Math.min(Math.round(m.tMs), inp.durationMs - 1),
        frame_at_ms: Math.min(Math.round(m.frameAtMs), inp.durationMs - 1),
        reason: m.caption.slice(0, 1000),
        source: m.source === "deixis" ? "spoken" : m.source,
      };
      if (coordsTrusted && m.x != null && m.y != null) {
        moment.x = m.x;
        moment.y = m.y;
      }
      return moment;
    })
    .filter((m, i, all) => i === 0 || m.timestamp_ms !== all[i - 1].timestamp_ms)
    .slice(0, LOCAL_V2_MOMENTS_MAX);
  return { schemaVersion: 2, moments };
}

async function withFakeProvider(reply, fenced, fn) {
  const seen = { requests: 0 };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.requests += 1;
    seen.authorization = req.headers.authorization ?? null;
    seen.path = req.url;
    seen.body = raw;
    const content = fenced ? "```json\n" + JSON.stringify(reply) + "\n```" : JSON.stringify(reply);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const result = await fn(`http://127.0.0.1:${port}/v1`);
    return { result, seen };
  } finally {
    server.close();
  }
}

/**
 * Captions are cut at UTF-16 code units (String.prototype.slice), so a cut can
 * split an emoji and leave half a surrogate pair. Rust strings are UTF-8 and
 * cannot hold one, and any UTF-8 encoder turns it into U+FFFD, so the expected
 * output is recorded the same way.
 */
function wellFormed(value) {
  if (typeof value === "string") return value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wellFormed(v)]));
  return value;
}

const v2 = (plan) => {
  if (!("schemaVersion" in plan)) throw new Error("expected a v2 plan");
  return wellFormed(plan.moments);
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const c of cases) {
  const rules = await planMoments(c.input);
  if (rules.planner !== "rules") throw new Error(`${c.name}: rules-only run reported ${rules.planner}`);

  // The replica must match planMoments wherever both can run.
  const replica = rulesWithTimeline(c.input, []);
  if (JSON.stringify(wellFormed(replica.moments)) !== JSON.stringify(v2(rules.plan))) {
    throw new Error(`${c.name}: rulesWithTimeline does not reproduce planMoments; fix the replica first`);
  }

  const golden = { name: c.name, description: c.description, input: c.input };
  if (c.captureTimeline) {
    golden.input = { ...c.input, captureTimeline: c.captureTimeline };
    golden.rules = { planner: "rules", moments: wellFormed(rulesWithTimeline(c.input, c.captureTimeline).moments) };
  } else {
    golden.rules = { planner: "rules", moments: v2(rules.plan) };
  }

  if (c.cues) {
    const reply = { moments: c.cues };
    const { result, seen } = await withFakeProvider(reply, c.fenced, (baseUrl) =>
      planMoments(c.input, { provider: { baseUrl, apiKey: "test-key", model: "test/model" } }),
    );
    golden.model = {
      reply: c.fenced ? "```json\n" + JSON.stringify(reply) + "\n```" : JSON.stringify(reply),
      planner: result.planner,
      moments: v2(result.plan),
      request: { requests: seen.requests, path: seen.path, authorization: seen.authorization, body: seen.body ?? null },
    };
  }

  writeFileSync(join(OUT, `${c.name}.json`), `${JSON.stringify(golden, null, 2)}\n`);
  const count = golden.rules.moments.length;
  process.stdout.write(`[golden] ${c.name}: ${count} rule moments${golden.model ? `, ${golden.model.moments.length} with the model` : ""}\n`);
}

process.stdout.write(`[golden] wrote ${readdirSync(OUT).length} files to ${OUT}\n`);
