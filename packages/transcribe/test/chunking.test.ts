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

  it("parses timestamps in scientific exponent notation (Issue #2)", () => {
    const out = [
      "[silencedetect @ 0x1] silence_start: 6.25e-05",
      "[silencedetect @ 0x1] silence_end: 1.25e-01 | silence_duration: 1.249375e-01",
      "[silencedetect @ 0x1] silence_start: -2.5e-04",
      "[silencedetect @ 0x1] silence_end: 3.5e-01 | silence_duration: 3.5025e-01",
    ].join("\n");
    const spans = parseSilencedetectOutput(out);
    expect(spans).toHaveLength(2);
    expect(spans[0].startSec).toBeCloseTo(0.0000625, 7);
    expect(spans[0].endSec).toBeCloseTo(0.125, 3);
    expect(spans[1].startSec).toBe(0); // clamped from negative exponent
    expect(spans[1].endSec).toBeCloseTo(0.35, 2);
  });

  it("handles Windows CRLF line endings, negative start, orphan end, and zero-length spans (Issue #6)", () => {
    const crlfOut = [
      "[silencedetect @ 0x1] silence_start: -0.5\r\n",
      "[silencedetect @ 0x1] silence_end: 2.0 | silence_duration: 2.5\r\n",
      // End line with no preceding start line: start is calculated as end - duration (3.0 - 1.0 = 2.0)
      "[silencedetect @ 0x1] silence_end: 3.0 | silence_duration: 1.0\r\n",
      // Zero-length span (endSec === startSec): should be dropped
      "[silencedetect @ 0x1] silence_start: 4.0\r\n",
      "[silencedetect @ 0x1] silence_end: 4.0 | silence_duration: 0\r\n",
      // Regular span with CRLF
      "[silencedetect @ 0x1] silence_start: 5.0\r\n",
      "[silencedetect @ 0x1] silence_end: 6.5 | silence_duration: 1.5\r\n",
    ].join("");

    const spans = parseSilencedetectOutput(crlfOut);
    expect(spans).toEqual([
      { startSec: 0, endSec: 2.0 },
      { startSec: 2.0, endSec: 3.0 },
      { startSec: 5.0, endSec: 6.5 },
    ]);
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

  it("recognises sentence ends with curly quotes, ellipsis, and CJK brackets (Issue #1)", () => {
    // 1. Plain "done."
    const plainWords = [
      { start: 0, end: 1, text: "We" },
      { start: 1, end: 2, text: "are" },
      { start: 2, end: 3.5, text: "done." },
      { start: 3.5, end: 4, text: "Next" },
    ];
    const plainSegs = groupWordsIntoSegments(plainWords);
    expect(plainSegs).toHaveLength(2);
    expect(plainSegs[0].text).toBe("We are done.");
    expect(plainSegs[1].text).toBe("Next");

    // 2. Curly quote "done.”"
    const quoteWords = [
      { start: 0, end: 1, text: "She" },
      { start: 1, end: 2, text: "said" },
      { start: 2, end: 3.5, text: "done.”" },
      { start: 3.5, end: 4, text: "Next" },
    ];
    const quoteSegs = groupWordsIntoSegments(quoteWords);
    expect(quoteSegs).toHaveLength(2);
    expect(quoteSegs[0].text).toBe("She said done.”");
    expect(quoteSegs[1].text).toBe("Next");

    // 3. Ellipsis "wait…"
    const ellipsisWords = [
      { start: 0, end: 1, text: "Please" },
      { start: 1, end: 2, text: "just" },
      { start: 2, end: 3.5, text: "wait…" },
      { start: 3.5, end: 4, text: "Next" },
    ];
    const ellipsisSegs = groupWordsIntoSegments(ellipsisWords);
    expect(ellipsisSegs).toHaveLength(2);
    expect(ellipsisSegs[0].text).toBe("Please just wait…");
    expect(ellipsisSegs[1].text).toBe("Next");

    // 4. CJK closing brackets "「終わり。」"
    const cjkWords = [
      { start: 0, end: 1, text: "これ" },
      { start: 1, end: 2, text: "で" },
      { start: 2, end: 3.5, text: "「終わり。」" },
      { start: 3.5, end: 4, text: "次" },
    ];
    const cjkSegs = groupWordsIntoSegments(cjkWords);
    expect(cjkSegs).toHaveLength(2);
    expect(cjkSegs[0].text).toBe("これで「終わり。」");
    expect(cjkSegs[1].text).toBe("次");
  });

  it("joins words without spaces for non-space scripts (Issue #33)", () => {
    // Japanese
    const japaneseWords = [
      { start: 0, end: 0.5, text: "これ" },
      { start: 0.5, end: 0.8, text: "は" },
      { start: 0.8, end: 1.5, text: "テスト" },
      { start: 1.5, end: 2.0, text: "です" },
      { start: 2.0, end: 2.2, text: "。" },
    ];
    const jaSegs = groupWordsIntoSegments(japaneseWords);
    expect(jaSegs).toHaveLength(1);
    expect(jaSegs[0].text).toBe("これはテストです。");

    // Chinese
    const chineseWords = [
      { start: 0, end: 0.5, text: "欢迎" },
      { start: 0.5, end: 1.0, text: "使用" },
      { start: 1.0, end: 1.5, text: "系统" },
    ];
    const zhSegs = groupWordsIntoSegments(chineseWords);
    expect(zhSegs).toHaveLength(1);
    expect(zhSegs[0].text).toBe("欢迎使用系统");

    // Korean maintains spaces between words
    const koreanWords = [
      { start: 0, end: 0.5, text: "안녕" },
      { start: 0.5, end: 1.0, text: "하세요" },
    ];
    const koSegs = groupWordsIntoSegments(koreanWords);
    expect(koSegs).toHaveLength(1);
    expect(koSegs[0].text).toBe("안녕 하세요");

    // Thai
    const thaiWords = [
      { start: 0, end: 0.5, text: "สวัสดี" },
      { start: 0.5, end: 1.0, text: "ครับ" },
    ];
    const thaiSegs = groupWordsIntoSegments(thaiWords);
    expect(thaiSegs[0].text).toBe("สวัสดีครับ");

    // Khmer
    const khmerWords = [
      { start: 0, end: 0.5, text: "សួស្តី" },
      { start: 0.5, end: 1.0, text: "កម្ពុជា" },
    ];
    const khmerSegs = groupWordsIntoSegments(khmerWords);
    expect(khmerSegs[0].text).toBe("សួស្តីកម្ពុជា");

    // Lao
    const laoWords = [
      { start: 0, end: 0.5, text: "ສະບາຍ" },
      { start: 0.5, end: 1.0, text: "ດີ" },
    ];
    const laoSegs = groupWordsIntoSegments(laoWords);
    expect(laoSegs[0].text).toBe("ສະບາຍດີ");

    // Burmese
    const burmeseWords = [
      { start: 0, end: 0.5, text: "မင်္ဂလာ" },
      { start: 0.5, end: 1.0, text: "ပါ" },
    ];
    const burmeseSegs = groupWordsIntoSegments(burmeseWords);
    expect(burmeseSegs[0].text).toBe("မင်္ဂလာပါ");

    // Mixed script (Latin + CJK)
    const mixedWords = [
      { start: 0, end: 0.5, text: "Clipy" },
      { start: 0.5, end: 1.0, text: "録画" },
    ];
    const mixedSegs = groupWordsIntoSegments(mixedWords);
    expect(mixedSegs[0].text).toBe("Clipy録画");

    // Clinging punctuation
    const punctWords = [
      { start: 0, end: 0.5, text: "Hello" },
      { start: 0.5, end: 0.8, text: "," },
      { start: 0.8, end: 1.2, text: "world" },
      { start: 1.2, end: 1.5, text: "!" },
    ];
    const punctSegs = groupWordsIntoSegments(punctWords);
    expect(punctSegs[0].text).toBe("Hello, world!");

    // Custom joiner override
    const customWords = [
      { start: 0, end: 0.5, text: "Alpha" },
      { start: 0.5, end: 1.0, text: "Beta" },
    ];
    const customSegs = groupWordsIntoSegments(customWords, "-");
    expect(customSegs[0].text).toBe("Alpha-Beta");
  });
});
