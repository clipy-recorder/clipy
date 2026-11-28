import { describe, expect, it } from "vitest";
import {
  groupTokensIntoSegments,
  groupWordsIntoSegments,
  mergePieces,
  parseSilencedetectOutput,
  planChunks,
  speechSecIn,
  tokensInCore,
  trimToSpeech,
  type ChunkPlan,
  type SilenceSpan,
} from "../src/chunking.js";
import { LOCAL_CHUNKING } from "../src/local.js";

/** Every piece fits the limit, cores tile [0, total) without gaps or overlap. */
function assertTiles(plan: ChunkPlan[], total: number, maxSec: number) {
  expect(plan.length).toBeGreaterThan(0);
  for (const p of plan) {
    expect(p.extractDurSec).toBeLessThanOrEqual(maxSec + 1e-9);
    expect(p.extractStartSec).toBeGreaterThanOrEqual(0);
    expect(p.extractStartSec + p.extractDurSec).toBeLessThanOrEqual(total + 1e-9);
  }
  expect(plan[0].keepStartSec).toBe(-Infinity);
  expect(plan[plan.length - 1].keepEndSec).toBe(Infinity);
  for (let i = 0; i + 1 < plan.length; i++) {
    expect(plan[i].keepEndSec).toBe(plan[i + 1].keepStartSec);
    // The core sits inside the extracted audio.
    expect(plan[i + 1].keepStartSec).toBeGreaterThanOrEqual(plan[i + 1].extractStartSec);
    expect(plan[i].keepEndSec).toBeLessThanOrEqual(plan[i].extractStartSec + plan[i].extractDurSec + 1e-9);
  }
}

describe("parseSilencedetectOutput", () => {
  it("reads spans and closes one left open at the end", () => {
    const out = [
      "[silencedetect @ 0x1] silence_start: 1.5",
      "[silencedetect @ 0x1] silence_end: 2.75 | silence_duration: 1.25",
      "[silencedetect @ 0x1] silence_start: -0.01",
      "[silencedetect @ 0x1] silence_end: 0.4 | silence_duration: 0.41",
      "[silencedetect @ 0x1] silence_start: 9",
    ].join("\n");
    expect(parseSilencedetectOutput(out, 10)).toEqual([
      { startSec: 1.5, endSec: 2.75 },
      { startSec: 0, endSec: 0.4 },
      { startSec: 9, endSec: 10 },
    ]);
    expect(parseSilencedetectOutput(out)).toHaveLength(2);
  });
});

describe("planChunks", () => {
  const parakeet = LOCAL_CHUNKING["english-fast"];

  it("keeps a recording that fits as one piece", () => {
    const plan = planChunks([], 170, parakeet);
    expect(plan).toEqual([{ index: 0, extractStartSec: 0, extractDurSec: 170, keepStartSec: -Infinity, keepEndSec: Infinity, hardCut: false }]);
    expect(planChunks([], 0, parakeet)).toEqual([]);
  });

  it("cuts inside the silence nearest the target", () => {
    const silences: SilenceSpan[] = [
      { startSec: 60, endSec: 61 },
      { startSec: 127, endSec: 129 }, // mid 128, nearest 130
      { startSec: 150, endSec: 151 },
      { startSec: 259, endSec: 261 }, // mid 260
    ];
    const plan = planChunks(silences, 400, parakeet);
    assertTiles(plan, 400, parakeet.maxSec);
    expect(plan[0].keepEndSec).toBe(128);
    expect(plan[1].keepEndSec).toBe(260);
    expect(plan.every((p) => !p.hardCut)).toBe(true);
    // Overlap on both sides of a cut.
    expect(plan[1].extractStartSec).toBe(125.5);
    expect(plan[1].extractDurSec).toBeCloseTo(260 + 2.5 - 125.5);
  });

  it("cuts mid-audio when there is no silence, and still never exceeds the limit", () => {
    const plan = planChunks([], 3600, parakeet);
    assertTiles(plan, 3600, parakeet.maxSec);
    expect(plan.every((p) => p.hardCut)).toBe(true);
    expect(plan.length).toBe(Math.ceil(3600 / 130));
  });

  it("ignores a silence outside the reachable window", () => {
    // Only silence at 179.5 s: beyond the first piece's core limit (177.5 s).
    const plan = planChunks([{ startSec: 179, endSec: 180 }], 300, parakeet);
    assertTiles(plan, 300, parakeet.maxSec);
    expect(plan[0].hardCut).toBe(true);
    expect(plan[0].keepEndSec).toBe(130);
  });

  it("keeps Whisper pieces under 30 s with no overlap", () => {
    const opts = LOCAL_CHUNKING.multilingual;
    const silences: SilenceSpan[] = [];
    for (let t = 7; t < 600; t += 9) silences.push({ startSec: t, endSec: t + 0.6 });
    const plan = planChunks(silences, 600, opts);
    assertTiles(plan, 600, opts.maxSec);
    for (const p of plan) {
      expect(p.extractDurSec).toBeLessThan(30);
      if (p.index > 0) expect(p.extractStartSec).toBe(p.keepStartSec);
    }
  });

  it("holds the limit across many random silence layouts", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 200; run++) {
      const total = 30 + rnd() * 4000;
      const silences: SilenceSpan[] = [];
      for (let t = rnd() * 50; t < total; t += 5 + rnd() * 300) silences.push({ startSec: t, endSec: t + 0.4 + rnd() * 3 });
      for (const opts of Object.values(LOCAL_CHUNKING)) assertTiles(planChunks(silences, total, opts), total, opts.maxSec);
    }
  });
});

describe("speechSecIn and trimToSpeech", () => {
  const silences = [
    { startSec: 0, endSec: 2 },
    { startSec: 5, endSec: 6 },
    { startSec: 9, endSec: 12 },
  ];
  it("measures speech between silences", () => {
    expect(speechSecIn(silences, 0, 10)).toBe(6);
    expect(speechSecIn(silences, 9.5, 11)).toBe(0);
  });
  it("trims silence off both edges", () => {
    expect(trimToSpeech(silences, 1, 10)).toEqual({ startSec: 2, endSec: 9 });
    expect(trimToSpeech(silences, 3, 4)).toEqual({ startSec: 3, endSec: 4 });
  });
});

describe("mergePieces", () => {
  it("offsets each piece, keeps each overlapped segment once, and never overlaps", () => {
    const plan = planChunks([{ startSec: 129, endSec: 131 }], 250, LOCAL_CHUNKING["english-fast"]);
    expect(plan).toHaveLength(2);
    const [a, b] = plan;
    expect(a.keepEndSec).toBe(130);
    const merged = mergePieces([
      {
        plan: a,
        segments: [
          { start: 0.5, end: 3, text: "hello there" },
          { start: 127, end: 129.5, text: "end of first" },
          { start: 131, end: 132, text: "dup seen by first" }, // centre 131.5, belongs to b
        ],
      },
      {
        plan: b, // extract starts at 127.5
        segments: [
          { start: 0, end: 1.5, text: "end of first" }, // 127.5..129, centre in a's core: dropped
          { start: 3.5, end: 4.5, text: "dup seen by first" }, // 131..132
          { start: 10, end: 12, text: "later" },
        ],
      },
    ]);
    expect(merged).toEqual([
      { startMs: 500, endMs: 3000, text: "hello there" },
      { startMs: 127000, endMs: 129500, text: "end of first" },
      { startMs: 131000, endMs: 132000, text: "dup seen by first" },
      { startMs: 137500, endMs: 139500, text: "later" },
    ]);
  });

  it("nudges overlapping segments apart", () => {
    const plan = planChunks([], 10, LOCAL_CHUNKING["english-fast"]);
    const merged = mergePieces([{ plan: plan[0], segments: [{ start: 1, end: 3, text: "a" }, { start: 2.5, end: 4, text: "b" }] }]);
    expect(merged[1]).toEqual({ startMs: 3000, endMs: 4000, text: "b" });
  });
});

describe("grouping", () => {
  it("groups tokens at pauses", () => {
    const segs = groupTokensIntoSegments([" Hello", " world", ".", " Next", " one"], [0.1, 0.4, 0.6, 2.0, 2.3]);
    expect(segs.map((s) => s.text)).toEqual(["Hello world.", "Next one"]);
    expect(segs[0].start).toBe(0.1);
    expect(segs[1].start).toBe(2.0);
    expect(segs[0].end).toBeLessThanOrEqual(segs[1].start);
  });

  it("keeps a full stop emitted after the pause with its sentence", () => {
    const segs = groupTokensIntoSegments([" Done", ".", " Next"], [1.0, 2.5, 2.6]);
    expect(segs.map((s) => s.text)).toEqual(["Done.", "Next"]);
    expect(segs[0].end).toBeCloseTo(1.4);
  });

  it("only splits a long run where a word starts", () => {
    const tokens = [" a"];
    const ts = [0];
    for (let i = 1; i <= 40; i++) {
      tokens.push(i === 37 ? "x" : " w");
      ts.push(i * 0.5);
    }
    const segs = groupTokensIntoSegments(tokens, ts);
    // At 18.5 s the token "x" continues a word, so the split waits for " w" at 19 s.
    expect(segs.map((s) => s.text)).toEqual([`a${" w".repeat(36)}x`, "w w w"]);
  });

  it("assigns each token to the piece whose core holds it", () => {
    const [a, b] = planChunks([{ startSec: 129, endSec: 131 }], 250, LOCAL_CHUNKING["english-fast"]);
    // A sentence running across the cut at 130 s, seen by both pieces.
    const fromA = tokensInCore(a, [" one", " two", " three"], [128, 129.5, 131]);
    const fromB = tokensInCore(b, [" one", " two", " three"], [128 - 127.5, 129.5 - 127.5, 131 - 127.5]);
    expect(fromA).toEqual([{ token: " one", t: 128 }, { token: " two", t: 129.5 }]);
    expect(fromB).toEqual([{ token: " three", t: 131 }]);
  });

  it("groups words at sentence ends and pauses", () => {
    const words = [
      { start: 0, end: 0.5, text: "This" },
      { start: 0.5, end: 1, text: "is" },
      { start: 1, end: 3.2, text: "first." },
      { start: 3.3, end: 3.6, text: "Then" },
      { start: 3.6, end: 4, text: "more" },
      { start: 6, end: 6.5, text: "after" },
      { start: 6.5, end: 7, text: "pause" },
    ];
    expect(groupWordsIntoSegments(words)).toEqual([
      { start: 0, end: 3.2, text: "This is first." },
      { start: 3.3, end: 4, text: "Then more" },
      { start: 6, end: 7, text: "after pause" },
    ]);
  });

  it.each([
    "done.",
    "done!",
    "done?",
    "終わり。",
    "終わり！",
    "終わり？",
    "wait…",
    'done.”',
    "done.’",
    'done."',
    "done.)",
    "done.]",
    "done.}",
    "「終わり。」",
    "『終わり。』",
    "（終わり。）",
  ])("breaks after viewer-supported sentence ending %s", (text) => {
    const words = [
      { start: 0, end: 3, text },
      { start: 3.1, end: 3.5, text: "Next" },
    ];
    expect(groupWordsIntoSegments(words).map((segment) => segment.text)).toEqual([text, "Next"]);
  });
});
