import { describe, expect, it } from "vitest";
import { boundInteractions, MAX_PLANNER_INTERACTIONS } from "../src/index.js";

// ---------------------------------------------------------------------------
// Minimal seeded PRNG — the same LCG pattern used in transcribe/chunking.test.ts
// ---------------------------------------------------------------------------
function makePrng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

// ---------------------------------------------------------------------------
// Event-array generator
// ---------------------------------------------------------------------------
type Event = {
  kind: string;
  time_ms: number;
  x?: number;
  y?: number;
  button?: number;
  key_code?: number;
  active?: boolean;
};

const LETTER_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 31, 32, 34, 35, 37, 38, 40, 45, 46, 49];
// macOS Control keycodes (the "flare" / hold-to-highlight key)
const CONTROL_CODES = [59, 62] as const;
// macOS modifier keycodes (54-63); excluded from chord detection but kept during a Control hold
const MODIFIER_CODES = [54, 55, 56, 57, 58, 60, 61, 63];

function isControlCode(code: number) {
  return code === 59 || code === 62;
}

/**
 * Build a random interaction event array.
 *
 * The generator mirrors the kind of content boundInteractions sees in
 * production:
 * - pointer moves (the bulk of events in long recordings)
 * - mouse down / up pairs
 * - regular key down / up pairs (letter keys)
 * - Control key down / up pairs (flare triggers)
 * - modifier-only key presses during a Control hold
 * - non-modifier key presses during a Control hold (chords)
 * - annotation open / close pairs
 * - scroll events
 *
 * `density` controls the fraction of non-move events (0–1).
 * `length` is the target total event count.
 */
function generateEvents(rnd: () => number, length: number, density = 0.3): Event[] {
  const events: Event[] = [];
  let t = 0;

  while (events.length < length) {
    t += 10 + Math.floor(rnd() * 50);
    const roll = rnd();

    if (roll < density * 0.08) {
      // Control key pair (flare)
      const code = CONTROL_CODES[Math.floor(rnd() * CONTROL_CODES.length)];
      events.push({ kind: "key_down", time_ms: t, key_code: code });
      t += 50 + Math.floor(rnd() * 1500);
      if (rnd() < 0.5 && events.length < length) {
        // Chord: non-modifier key while Control held
        const chord = LETTER_CODES[Math.floor(rnd() * LETTER_CODES.length)];
        events.push({ kind: "key_down", time_ms: t, key_code: chord });
        events.push({ kind: "key_up", time_ms: t + 60, key_code: chord });
      }
      events.push({ kind: "key_up", time_ms: t + 10, key_code: code });
    } else if (roll < density * 0.08 + density * 0.04) {
      // Modifier-only key press (during hold or standalone)
      const code = MODIFIER_CODES[Math.floor(rnd() * MODIFIER_CODES.length)];
      events.push({ kind: "key_down", time_ms: t, key_code: code });
      events.push({ kind: "key_up", time_ms: t + 80, key_code: code });
    } else if (roll < density * 0.2) {
      // Regular letter key pair
      const code = LETTER_CODES[Math.floor(rnd() * LETTER_CODES.length)];
      events.push({ kind: "key_down", time_ms: t, key_code: code });
      events.push({ kind: "key_up", time_ms: t + 60, key_code: code });
    } else if (roll < density * 0.3) {
      // Mouse click pair
      const btn = Math.floor(rnd() * 3);
      events.push({ kind: "down", time_ms: t, x: Math.floor(rnd() * 1920), y: Math.floor(rnd() * 1080), button: btn });
      events.push({ kind: "up", time_ms: t + 80, x: Math.floor(rnd() * 1920), y: Math.floor(rnd() * 1080), button: btn });
    } else if (roll < density * 0.35) {
      // Annotation pair
      events.push({ kind: "annotation", time_ms: t, active: true });
      events.push({ kind: "annotation", time_ms: t + 500 + Math.floor(rnd() * 3000), active: false });
    } else if (roll < density * 0.4) {
      // Scroll event
      events.push({ kind: "scroll", time_ms: t, x: Math.floor(rnd() * 1920), y: Math.floor(rnd() * 1080) });
    } else {
      // Pointer move (the dominant event type)
      events.push({ kind: "move", time_ms: t, x: Math.floor(rnd() * 1920), y: Math.floor(rnd() * 1080) });
    }
  }
  return events.slice(0, length);
}

// ---------------------------------------------------------------------------
// Helpers that mirror what thinEdges / boundInteractions guarantee
// ---------------------------------------------------------------------------

/** Returns the indices of `bounded` inside `original` as a strictly-increasing sequence. */
function subsequenceIndices(original: readonly Event[], bounded: readonly Event[]): number[] {
  const indices: number[] = [];
  let cursor = 0;
  for (const e of bounded) {
    while (cursor < original.length && original[cursor] !== e) cursor++;
    if (cursor >= original.length) return []; // not a subsequence
    indices.push(cursor++);
  }
  return indices;
}

function isStrictlyIncreasing(arr: number[]): boolean {
  for (let i = 1; i < arr.length; i++) if (arr[i] <= arr[i - 1]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("boundInteractions — property tests (seeded random)", () => {
  /**
   * Run 300 seeds spanning a wide range of event-array shapes
   * (short, at-limit, well-over-limit; sparse and dense edge events).
   */
  it("output length never exceeds the limit", () => {
    const seed = 7;
    const rnd = makePrng(seed);
    for (let run = 0; run < 300; run++) {
      const length = Math.floor(50 + rnd() * 20_000);
      const density = 0.1 + rnd() * 0.8;
      const limit = Math.floor(500 + rnd() * (MAX_PLANNER_INTERACTIONS * 2));
      const events = generateEvents(rnd, length, density);
      const bounded = boundInteractions(events, limit);
      expect(bounded.length).toBeLessThanOrEqual(limit);
    }
  });

  it("original event order is preserved (bounded result is a subsequence)", () => {
    const seed = 42;
    const rnd = makePrng(seed);
    for (let run = 0; run < 300; run++) {
      const length = Math.floor(100 + rnd() * 15_000);
      const density = 0.1 + rnd() * 0.7;
      const limit = Math.floor(200 + rnd() * MAX_PLANNER_INTERACTIONS);
      const events = generateEvents(rnd, length, density);
      if (events.length <= limit) continue; // subsequence property only matters when thinning occurs
      const bounded = boundInteractions(events, limit);
      const indices = subsequenceIndices(events, bounded);
      expect(indices.length).toBe(bounded.length);
      expect(isStrictlyIncreasing(indices)).toBe(true);
    }
  });

  it("inputs at or under the limit are returned unchanged (same reference)", () => {
    const seed = 99;
    const rnd = makePrng(seed);
    for (let run = 0; run < 300; run++) {
      const limit = Math.floor(100 + rnd() * MAX_PLANNER_INTERACTIONS);
      const length = Math.floor(rnd() * limit); // always <= limit
      const events = generateEvents(rnd, length, 0.3);
      expect(boundInteractions(events, limit)).toBe(events);
    }
  });

  it("every Control key event is retained when edges alone fit within the limit", () => {
    const seed = 13;
    const rnd = makePrng(seed);
    for (let run = 0; run < 300; run++) {
      // Build an event set where Control key events definitely fit: produce
      // very few Control presses so they will never be sampled away.
      const length = Math.floor(2_000 + rnd() * 18_000);
      // Low density keeps total edge count manageable.
      const density = 0.05 + rnd() * 0.15;
      const events = generateEvents(rnd, length, density);

      const controlEvents = events.filter(
        (e) => (e.kind === "key_down" || e.kind === "key_up") && typeof e.key_code === "number" && isControlCode(e.key_code),
      );

      // Only verify the guarantee when Control events fit in the limit by themselves.
      if (controlEvents.length > MAX_PLANNER_INTERACTIONS) continue;

      const bounded = boundInteractions(events, MAX_PLANNER_INTERACTIONS);
      const keptSet = new Set(bounded);

      for (const ctrl of controlEvents) {
        expect(keptSet.has(ctrl)).toBe(true);
      }
    }
  });

  it("every annotation event is retained when annotations alone fit within the limit", () => {
    const seed = 17;
    const rnd = makePrng(seed);
    for (let run = 0; run < 300; run++) {
      const length = Math.floor(2_000 + rnd() * 18_000);
      const density = 0.05 + rnd() * 0.15;
      const events = generateEvents(rnd, length, density);

      const annotationEvents = events.filter((e) => e.kind === "annotation");

      if (annotationEvents.length > MAX_PLANNER_INTERACTIONS) continue;

      const bounded = boundInteractions(events, MAX_PLANNER_INTERACTIONS);
      const keptSet = new Set(bounded);

      for (const ann of annotationEvents) {
        expect(keptSet.has(ann)).toBe(true);
      }
    }
  });

  it("Control key events AND annotations are both retained together when they fit within the limit", () => {
    // This is the combined guarantee: both are always kept if they collectively
    // fit in the budget (the actual thinEdges invariant).
    const seed = 31;
    const rnd = makePrng(seed);
    for (let run = 0; run < 300; run++) {
      const length = Math.floor(2_000 + rnd() * 18_000);
      // Keep density low so the combined mandatory-keep set stays small.
      const density = 0.03 + rnd() * 0.1;
      const events = generateEvents(rnd, length, density);

      const mandatory = events.filter(
        (e) =>
          e.kind === "annotation" ||
          ((e.kind === "key_down" || e.kind === "key_up") && typeof e.key_code === "number" && isControlCode(e.key_code)),
      );

      if (mandatory.length > MAX_PLANNER_INTERACTIONS) continue;

      const bounded = boundInteractions(events, MAX_PLANNER_INTERACTIONS);
      const keptSet = new Set(bounded);

      for (const m of mandatory) {
        expect(keptSet.has(m)).toBe(true);
      }
    }
  });
});
