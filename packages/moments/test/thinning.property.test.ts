import { describe, expect, it } from "vitest";
import { boundInteractions } from "../src/index.js";

type InteractionKind = "move" | "down" | "up" | "scroll" | "key_down" | "key_up" | "annotation";

interface SyntheticEvent {
  kind: InteractionKind;
  time_ms: number;
  x?: number;
  y?: number;
  button?: number;
  key_code?: number;
  text?: string;
}

/** Deterministic pseudo-random number generator for reproducible property tests. */
function createRng(seed = 12345) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Generates a pseudo-random list of interaction events. */
function generateSyntheticEvents(count: number, rng: () => number): SyntheticEvent[] {
  const events: SyntheticEvent[] = [];
  let currentTime = 0;
  let activeControl = false;

  for (let i = 0; i < count; i++) {
    currentTime += Math.floor(rng() * 100);
    const roll = rng();

    if (roll < 0.35) {
      // Mouse move
      events.push({
        kind: "move",
        time_ms: currentTime,
        x: Math.floor(rng() * 1920),
        y: Math.floor(rng() * 1080),
      });
    } else if (roll < 0.55) {
      // Paired click (down + up)
      const btn = rng() < 0.8 ? 1 : 2;
      const x = Math.floor(rng() * 1920);
      const y = Math.floor(rng() * 1080);
      events.push({ kind: "down", time_ms: currentTime, x, y, button: btn });
      currentTime += 50 + Math.floor(rng() * 50);
      events.push({ kind: "up", time_ms: currentTime, x, y, button: btn });
    } else if (roll < 0.70) {
      // Control hold / flare
      if (!activeControl) {
        events.push({ kind: "key_down", time_ms: currentTime, key_code: 59 });
        activeControl = true;
      } else {
        events.push({ kind: "key_up", time_ms: currentTime, key_code: 59 });
        activeControl = false;
      }
    } else if (roll < 0.85) {
      // Key press (or chord if control is active)
      const code = Math.floor(rng() * 50) + 1; // non-modifier key code
      events.push({ kind: "key_down", time_ms: currentTime, key_code: code });
      currentTime += 30;
      events.push({ kind: "key_up", time_ms: currentTime, key_code: code });
    } else if (roll < 0.95) {
      // Scroll
      events.push({ kind: "scroll", time_ms: currentTime, x: 500, y: 500 });
    } else {
      // Annotation
      events.push({ kind: "annotation", time_ms: currentTime, text: "highlight" });
    }
  }

  if (activeControl) {
    currentTime += 100;
    events.push({ kind: "key_up", time_ms: currentTime, key_code: 59 });
  }

  return events;
}

describe("boundInteractions property tests", () => {
  it("never exceeds the specified limit", () => {
    const rng = createRng(42);
    for (let run = 0; run < 25; run++) {
      const eventCount = Math.floor(rng() * 300) + 50;
      const limit = Math.floor(rng() * 50) + 10;
      const events = generateSyntheticEvents(eventCount, rng);

      const thinned = boundInteractions(events, limit);
      expect(thinned.length).toBeLessThanOrEqual(limit);
    }
  });

  it("is an identity function when event count <= limit", () => {
    const rng = createRng(99);
    for (let run = 0; run < 20; run++) {
      const count = Math.floor(rng() * 50) + 1;
      const events = generateSyntheticEvents(count, rng);
      const limit = count + 20;

      const result = boundInteractions(events, limit);
      expect(result).toBe(events);
      expect(result).toHaveLength(events.length);
    }
  });

  it("strictly preserves original relative chronological order", () => {
    const rng = createRng(101);
    for (let run = 0; run < 20; run++) {
      const events = generateSyntheticEvents(200, rng);
      const limit = 40;
      const thinned = boundInteractions(events, limit);

      // Verify that every retained element appeared in the same order
      let lastIndex = -1;
      for (const item of thinned) {
        const foundIndex = events.indexOf(item);
        expect(foundIndex).toBeGreaterThan(lastIndex);
        lastIndex = foundIndex;
      }
    }
  });

  it("prioritizes Control key flares and chords over simple pointer moves", () => {
    const events: SyntheticEvent[] = [];
    // 50 background moves
    for (let i = 0; i < 50; i++) {
      events.push({ kind: "move", time_ms: i * 10, x: i, y: i });
    }
    // A Control key hold and release
    events.push({ kind: "key_down", time_ms: 1000, key_code: 59 });
    events.push({ kind: "key_up", time_ms: 1500, key_code: 59 });

    // Thin down to budget 10
    const thinned = boundInteractions(events, 10);
    expect(thinned.length).toBeLessThanOrEqual(10);

    const hasKeyDown = thinned.some((e) => e.kind === "key_down" && e.key_code === 59);
    const hasKeyUp = thinned.some((e) => e.kind === "key_up" && e.key_code === 59);
    expect(hasKeyDown).toBe(true);
    expect(hasKeyUp).toBe(true);
  });
});
