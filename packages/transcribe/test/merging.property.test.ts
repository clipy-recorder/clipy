import { describe, expect, it } from "vitest";
import { mergePieces, type PieceResult } from "../src/chunking.js";

/** Deterministic pseudo-random number generator for reproducible property tests. */
function createRng(seed = 45678) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Generates overlapping synthetic pieces with relative segments. */
function generateSyntheticPieces(pieceCount: number, rng: () => number): PieceResult[] {
  const pieces: PieceResult[] = [];
  const pieceDuration = 30; // 30s pieces
  const overlap = 5; // 5s overlap on each side

  for (let i = 0; i < pieceCount; i++) {
    const extractStartSec = i * (pieceDuration - 2 * overlap);
    const keepStartSec = i === 0 ? -Infinity : extractStartSec + overlap;
    const keepEndSec = i === pieceCount - 1 ? Infinity : extractStartSec + pieceDuration - overlap;

    const segments: Array<{ start: number; end: number; text: string }> = [];
    const segmentCount = Math.floor(rng() * 6) + 1;
    let segTime = 0;

    for (let j = 0; j < segmentCount; j++) {
      segTime += rng() * 3;
      const dur = 1 + rng() * 4;
      if (segTime + dur > pieceDuration) break;
      segments.push({
        start: segTime,
        end: segTime + dur,
        text: `Segment p${i}_s${j} words`,
      });
      segTime += dur;
    }

    pieces.push({
      plan: {
        index: i,
        extractStartSec,
        extractDurSec: pieceDuration,
        keepStartSec,
        keepEndSec,
        hardCut: false,
      },
      segments,
    });
  }

  return pieces;
}

describe("mergePieces property tests", () => {
  it("always produces monotonic, non-overlapping segments (startMs >= prev.endMs)", () => {
    const rng = createRng(77);
    for (let run = 0; run < 30; run++) {
      const pieceCount = Math.floor(rng() * 5) + 1;
      const pieces = generateSyntheticPieces(pieceCount, rng);

      const merged = mergePieces(pieces);

      for (let i = 0; i < merged.length; i++) {
        const seg = merged[i];
        // Invariant 1: startMs <= endMs
        expect(seg.startMs).toBeLessThanOrEqual(seg.endMs);

        // Invariant 2: non-overlapping monotonic order
        if (i > 0) {
          const prev = merged[i - 1];
          expect(seg.startMs).toBeGreaterThanOrEqual(prev.endMs);
        }

        // Invariant 3: non-empty text
        expect(seg.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("filters out segments whose centre lies outside the piece's keep window", () => {
    const pieces: PieceResult[] = [
      {
        plan: {
          index: 0,
          extractStartSec: 0,
          extractDurSec: 20,
          keepStartSec: 0,
          keepEndSec: 10,
          hardCut: false,
        },
        segments: [
          { start: 2, end: 6, text: "Inside piece 0" }, // centre = 4 (kept)
          { start: 9, end: 15, text: "Outside piece 0" }, // centre = 12 (dropped)
        ],
      },
      {
        plan: {
          index: 1,
          extractStartSec: 8,
          extractDurSec: 20,
          keepStartSec: 10,
          keepEndSec: 30,
          hardCut: false,
        },
        segments: [
          { start: 2, end: 6, text: "Inside piece 1" }, // start=10, end=14, centre=12 (kept)
        ],
      },
    ];

    const merged = mergePieces(pieces);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe("Inside piece 0");
    expect(merged[1].text).toBe("Inside piece 1");
  });

  it("ignores empty or whitespace-only transcript segments", () => {
    const pieces: PieceResult[] = [
      {
        plan: {
          index: 0,
          extractStartSec: 0,
          extractDurSec: 10,
          keepStartSec: -Infinity,
          keepEndSec: Infinity,
          hardCut: false,
        },
        segments: [
          { start: 0, end: 2, text: "   " },
          { start: 2, end: 4, text: "" },
          { start: 4, end: 6, text: "Valid speech" },
        ],
      },
    ];

    const merged = mergePieces(pieces);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe("Valid speech");
  });
});
