import { describe, expect, it } from "vitest";
import { samplesToEvents, type PointerSample } from "../src/sidecar.js";

/** Deterministic pseudo-random number generator for reproducible property tests. */
function createRng(seed = 98765) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Generates synthetic pointer samples around a recording window. */
function generateSyntheticPointerSamples(
  count: number,
  startedAt: number,
  endedAt: number,
  rng: () => number,
): PointerSample[] {
  const samples: PointerSample[] = [];
  let t = startedAt - 500; // start 500ms before recording
  let x = 500;
  let y = 400;
  let buttons = 0;

  for (let i = 0; i < count; i++) {
    t += Math.floor(rng() * 50) + 10;
    // 30% chance position changes
    if (rng() < 0.6) {
      x += Math.floor(rng() * 20) - 10;
      y += Math.floor(rng() * 20) - 10;
    }
    // 15% chance button state toggles
    if (rng() < 0.15) {
      buttons = buttons === 0 ? 1 : 0;
    }

    samples.push({ t, x, y, buttons });
  }

  return samples;
}

describe("samplesToEvents property tests", () => {
  it("generates events strictly within the recording window with non-negative, non-decreasing time_ms", () => {
    const rng = createRng(12);
    const startedAt = 10000;
    const endedAt = 25000;

    for (let run = 0; run < 25; run++) {
      const samples = generateSyntheticPointerSamples(100, startedAt, endedAt, rng);
      const events = samplesToEvents(samples, startedAt, endedAt);

      let prevTime = 0;
      for (const event of events) {
        expect(event.time_ms).toBeGreaterThanOrEqual(0);
        expect(event.time_ms).toBeGreaterThanOrEqual(prevTime);
        expect(event.time_ms).toBeLessThanOrEqual(endedAt - startedAt + 10);
        prevTime = event.time_ms;
      }
    }
  });

  it("never emits consecutive identical move events with identical coordinates", () => {
    const rng = createRng(34);
    const startedAt = 5000;
    const endedAt = 15000;

    for (let run = 0; run < 20; run++) {
      const samples = generateSyntheticPointerSamples(120, startedAt, endedAt, rng);
      const events = samplesToEvents(samples, startedAt, endedAt);

      let lastMove: { x: number; y: number } | null = null;
      for (const e of events) {
        if (e.kind === "move" && e.x != null && e.y != null) {
          if (lastMove) {
            expect(lastMove.x === e.x && lastMove.y === e.y).toBe(false);
          }
          lastMove = { x: e.x, y: e.y };
        }
      }
    }
  });

  it("ensures every button 'up' was preceded by a matching 'down'", () => {
    const rng = createRng(56);
    const startedAt = 1000;
    const endedAt = 20000;

    for (let run = 0; run < 20; run++) {
      const samples = generateSyntheticPointerSamples(150, startedAt, endedAt, rng);
      const events = samplesToEvents(samples, startedAt, endedAt);

      const activeButtons = new Set<number>();
      for (const e of events) {
        if (e.kind === "down" && e.button != null) {
          activeButtons.add(e.button);
        } else if (e.kind === "up" && e.button != null) {
          // Invariant: button must have been pressed down during recording
          expect(activeButtons.has(e.button)).toBe(true);
          activeButtons.delete(e.button);
        }
      }
    }
  });

  it("discards all samples after endedAt", () => {
    const startedAt = 1000;
    const endedAt = 5000;
    const samples: PointerSample[] = [
      { t: 2000, x: 100, y: 100, buttons: 0 },
      { t: 4000, x: 200, y: 200, buttons: 0 },
      { t: 5001, x: 300, y: 300, buttons: 0 },
      { t: 6000, x: 400, y: 400, buttons: 0 },
    ];

    const events = samplesToEvents(samples, startedAt, endedAt);
    expect(events.some((e) => e.x === 300 || e.x === 400)).toBe(false);
  });
});
