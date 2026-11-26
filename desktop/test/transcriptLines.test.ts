import assert from "node:assert/strict";
import { test } from "node:test";
import { groupTranscriptLines, type TranscriptLineSegment } from "../src/lib/transcriptLines.ts";

test("groupTranscriptLines: groups words within a single thought", () => {
  const segments: TranscriptLineSegment[] = [
    { startMs: 0, endMs: 200, text: "Hello" },
    { startMs: 250, endMs: 500, text: "world" },
    { startMs: 550, endMs: 800, text: "this" },
    { startMs: 850, endMs: 1100, text: "is" },
    { startMs: 1150, endMs: 1400, text: "Clipy." },
  ];
  const lines = groupTranscriptLines(segments);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Hello world this is Clipy.");
  assert.equal(lines[0].startMs, 0);
  assert.equal(lines[0].endMs, 1400);
});

test("groupTranscriptLines: breaks on sentence end punctuation", () => {
  const segments: TranscriptLineSegment[] = [
    { startMs: 0, endMs: 300, text: "First sentence." },
    { startMs: 350, endMs: 650, text: "Second" },
    { startMs: 700, endMs: 900, text: "sentence!" },
    { startMs: 950, endMs: 1200, text: "Third?" },
  ];
  const lines = groupTranscriptLines(segments);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].text, "First sentence.");
  assert.equal(lines[1].text, "Second sentence!");
  assert.equal(lines[2].text, "Third?");
});

test("groupTranscriptLines: breaks on pauses >= 700ms", () => {
  const segments: TranscriptLineSegment[] = [
    { startMs: 0, endMs: 500, text: "Pause" },
    { startMs: 550, endMs: 1000, text: "incoming" },
    { startMs: 1750, endMs: 2200, text: "resumed" }, // 1750 - 1000 = 750ms >= 700ms
  ];
  const lines = groupTranscriptLines(segments);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Pause incoming");
  assert.equal(lines[1].text, "resumed");
});

test("groupTranscriptLines: breaks when line exceeds MAX_LINE_MS (14,000ms)", () => {
  const segments: TranscriptLineSegment[] = [
    { startMs: 0, endMs: 1000, text: "Start" },
    { startMs: 1050, endMs: 5000, text: "continuous" },
    { startMs: 5050, endMs: 10000, text: "speech" },
    { startMs: 10050, endMs: 14500, text: "overflow" }, // 14500 - 0 = 14500 >= 14000
  ];
  const lines = groupTranscriptLines(segments);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "Start continuous speech");
  assert.equal(lines[1].text, "overflow");
});

test("groupTranscriptLines: handles CJK and non-space scripts without spurious spaces", () => {
  const segments: TranscriptLineSegment[] = [
    { startMs: 0, endMs: 200, text: "こんにちは" },
    { startMs: 220, endMs: 400, text: "世界" },
  ];
  const lines = groupTranscriptLines(segments);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "こんにちは世界");
});

test("groupTranscriptLines: clings left-leaning punctuation tokens", () => {
  const segments: TranscriptLineSegment[] = [
    { startMs: 0, endMs: 200, text: "Wait" },
    { startMs: 210, endMs: 300, text: "," },
    { startMs: 320, endMs: 500, text: "really" },
    { startMs: 510, endMs: 600, text: "?" },
  ];
  const lines = groupTranscriptLines(segments);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "Wait, really?");
});

test("groupTranscriptLines: ignores empty or whitespace-only segments", () => {
  const segments: TranscriptLineSegment[] = [
    { startMs: 0, endMs: 200, text: "  " },
    { startMs: 250, endMs: 500, text: "valid" },
    { startMs: 550, endMs: 600, text: "" },
  ];
  const lines = groupTranscriptLines(segments);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "valid");
});
