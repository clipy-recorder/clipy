import { describe, expect, it } from "vitest";
import { planMoments, type LocalMomentInput } from "../src/index.js";

function input(overrides: Partial<LocalMomentInput> = {}): LocalMomentInput {
  return {
    schemaVersion: 2,
    durationMs: 1_000,
    transcript: [],
    interactions: [],
    clickElements: [],
    interactionSelection: "bounded sample; full stream retained locally",
    ...overrides,
  };
}

describe("recording timestamp boundaries", () => {
  it("accepts events at the start and exact stop boundary", async () => {
    const result = await planMoments(input({
      interactions: [
        { kind: "move", time_ms: 0 },
        { kind: "up", time_ms: 1_000 },
      ],
      clickElements: [{ time_ms: 1_000, role: null, label: null }],
    }));

    expect(result.planner).toBe("rules");
  });

  it("rejects an interaction after the recording duration with its field path", async () => {
    await expect(planMoments(input({ interactions: [{ kind: "move", time_ms: 1_001 }] }))).rejects.toThrow(
      "interactions[0].time_ms must not exceed durationMs (1000)",
    );
  });

  it("rejects a click element after the recording duration with its field path", async () => {
    await expect(
      planMoments(input({ clickElements: [{ time_ms: 1_001, role: null, label: null }] })),
    ).rejects.toThrow("clickElements[0].time_ms must not exceed durationMs (1000)");
  });
});
