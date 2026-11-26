import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/flare-sample.json" with { type: "json" };
import fenceCases from "./fixtures/code-fence-cases.json" with { type: "json" };
import {
  boundInteractions,
  describePlannerError,
  LLMError,
  MAX_PLANNER_INTERACTIONS,
  MODEL_ERROR,
  planMoments,
  type LocalMomentInput,
} from "../src/index.js";
import { MAX_COMPLETION_BYTES, stripCodeFence } from "../src/llm.js";
import { localPlannerRetry } from "../src/generated/localMomentPlan.js";
import { detectAnnotationSpans, detectFlareSpans } from "../src/generated/keyMomentsCursorContext.js";

// The provider payload for the synthetic flare sample (27 s, see
// fixtures/make-flare-sample.mjs), built the way a desktop app builds it.
function payload(): LocalMomentInput {
  const events = (fixture.events as Record<string, unknown>[]).map((e) => {
    const out: Record<string, unknown> = {};
    for (const key of ["kind", "time_ms", "x", "y", "button", "key_code", "delta_x", "delta_y", "active"]) {
      if (key in e) out[key] = e[key];
    }
    return out;
  });
  const { x, y, width, height, output_width, output_height } = fixture.capture;
  return {
    schemaVersion: 2,
    durationMs: fixture.durationMs,
    transcript: fixture.transcript,
    interactions: events,
    clickElements: fixture.click_elements,
    interactionSelection: "bounded sample; full stream retained locally",
    capture: { x, y, width, height, output_width, output_height },
  } as LocalMomentInput;
}

function v2(plan: Awaited<ReturnType<typeof planMoments>>["plan"]) {
  if (!("schemaVersion" in plan)) throw new Error("expected a v2 plan");
  return plan.moments;
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/**
 * A stand-in OpenAI-compatible endpoint that records what it was sent.
 * `failFirst` answers the first request with a 503, so the planner waits and
 * retries: the retry reads the provider again after other calls have run.
 */
async function fakeProvider(reply: unknown, opts: { failFirst?: boolean; rawContent?: boolean } = {}) {
  const seen: { auth?: string; body?: Record<string, unknown>; requests: number } = { requests: 0 };
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.requests += 1;
    seen.auth = req.headers.authorization;
    seen.body = JSON.parse(raw);
    if (opts.failFirst && seen.requests === 1) {
      res.statusCode = 503;
      res.end("{}");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    const content = opts.rawContent ? String(reply) : JSON.stringify(reply);
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, seen };
}

describe("planMoments, rules only (no provider)", () => {
  it("frames the hold-Control highlight and the clicks without any network", async () => {
    const { plan, planner } = await planMoments(payload());
    expect(planner).toBe("rules");
    const moments = v2(plan);

    const flare = moments.find((m) => m.source === "flare");
    // Timestamp: press plus the 120 ms grace. Frame: release minus 120 ms, where the pointer rests at (367, 471).
    expect(flare).toMatchObject({ timestamp_ms: 20_223, frame_at_ms: 22_633 });
    expect(flare?.x).toBeCloseTo(367 / 1512, 3);
    expect(flare?.y).toBeCloseTo(471 / 982, 3);
    expect(moments.some((m) => m.source === "click")).toBe(true);
    // No model ran, so nothing is a spoken cue.
    expect(moments.some((m) => m.source === "spoken")).toBe(false);
  });
});

describe("planMoments with an OpenAI-compatible provider", () => {
  it("adds the model's spoken cues on top of the rules", async () => {
    const { baseUrl, seen } = await fakeProvider({ moments: fixture.llmMoments });
    const { plan, planner } = await planMoments(payload(), {
      provider: { baseUrl, apiKey: "test-key", model: "test/model" },
    });
    expect(planner).toBe("rules+model");
    expect(seen.auth).toBe("Bearer test-key");
    expect(seen.body?.model).toBe("test/model");

    const moments = v2(plan);
    const spoken = moments.filter((m) => m.source === "spoken" || m.source === "fused" || m.source === "hover");
    expect(spoken.map((m) => m.timestamp_ms)).toEqual(expect.arrayContaining([10_120, 15_190, 25_130]));
    expect(moments.find((m) => m.source === "flare")).toBeDefined();
  });

  it("reports rules only when the model is never asked (empty transcript)", async () => {
    const { baseUrl, seen } = await fakeProvider({ moments: fixture.llmMoments });
    const { plan, planner } = await planMoments(
      { ...payload(), transcript: [] },
      { provider: { baseUrl, apiKey: "test-key", model: "test/model" } },
    );
    expect(seen.requests).toBe(0);
    expect(planner).toBe("rules");
    expect(v2(plan).find((m) => m.source === "flare")).toBeDefined();
  });

  it("reports rules+model only once the model has answered", async () => {
    const { baseUrl, seen } = await fakeProvider({ moments: [] });
    const { planner } = await planMoments(payload(), { provider: { baseUrl, model: "test/model" } });
    // The model was asked and answered (with no moments): its answer is in the plan.
    expect(seen.requests).toBe(1);
    expect(planner).toBe("rules+model");
  });

  it("does not keep the provider for the next call", async () => {
    const { baseUrl } = await fakeProvider({ moments: fixture.llmMoments });
    await planMoments(payload(), { provider: { baseUrl, model: "test/model" } });
    const { planner } = await planMoments(payload());
    expect(planner).toBe("rules");
  });
});

describe("planMoments called concurrently", () => {
  const spokenTimestamps = [10_120, 15_190, 25_130];
  const isSpoken = (m: { source: string }) => m.source === "spoken" || m.source === "fused" || m.source === "hover";
  const realDelays = localPlannerRetry.delaysMs;

  // A short retry wait keeps the test fast; the overlap is what matters.
  beforeEach(() => {
    localPlannerRetry.delaysMs = [150, 150];
  });
  afterEach(() => {
    localPlannerRetry.delaysMs = realDelays;
  });

  async function firstRequest(seen: { requests: number }) {
    while (seen.requests === 0) await new Promise((r) => setTimeout(r, 5));
  }

  it("keeps a rules-only call and a model call apart", async () => {
    const rulesAlone = v2((await planMoments(payload())).plan);
    const { baseUrl, seen } = await fakeProvider({ moments: fixture.llmMoments }, { failFirst: true });

    const withModel = planMoments(payload(), { provider: { baseUrl, apiKey: "test-key", model: "test/model" } });
    // Start the rules-only call while the model call waits to retry.
    await firstRequest(seen);
    const rulesOnly = await planMoments(payload());
    const modelResult = await withModel;

    // The model call's retry still went to its own provider.
    expect(seen.requests).toBe(2);
    expect(seen.auth).toBe("Bearer test-key");
    expect(seen.body?.model).toBe("test/model");
    expect(modelResult.planner).toBe("rules+model");
    expect(v2(modelResult.plan).filter(isSpoken).map((m) => m.timestamp_ms)).toEqual(
      expect.arrayContaining(spokenTimestamps),
    );

    // The rules-only call made no request and matches a rules-only run on its own.
    expect(rulesOnly.planner).toBe("rules");
    expect(v2(rulesOnly.plan).some((m) => m.source === "spoken")).toBe(false);
    expect(v2(rulesOnly.plan)).toEqual(rulesAlone);
  });

  it("keeps two different providers apart", async () => {
    const a = await fakeProvider({ moments: fixture.llmMoments }, { failFirst: true });
    const b = await fakeProvider({ moments: [] });

    const fromA = planMoments(payload(), { provider: { baseUrl: a.baseUrl, apiKey: "key-a", model: "model/a" } });
    await firstRequest(a.seen);
    const fromB = planMoments(payload(), { provider: { baseUrl: b.baseUrl, apiKey: "key-b", model: "model/b" } });
    const [resultA, resultB] = await Promise.all([fromA, fromB]);

    // A's key never reached B's server, and B's never reached A's.
    expect(a.seen).toMatchObject({ requests: 2, auth: "Bearer key-a", body: { model: "model/a" } });
    expect(b.seen).toMatchObject({ requests: 1, auth: "Bearer key-b", body: { model: "model/b" } });
    expect(v2(resultA.plan).filter(isSpoken).map((m) => m.timestamp_ms)).toEqual(expect.arrayContaining(spokenTimestamps));
    expect(v2(resultB.plan).some((m) => m.source === "spoken")).toBe(false);
  });
});

describe("model answers that cannot be used", () => {
  it("names no particular provider and keeps the planner's classification", () => {
    for (const [message, kind] of [
      [MODEL_ERROR.unparseable, "unparseable_json"],
      [MODEL_ERROR.noCompletion, "empty_completion"],
      [MODEL_ERROR.tooLarge, "provider_error"],
    ] as const) {
      expect(message).not.toMatch(/openrouter/i);
      expect(describePlannerError(new LLMError({ message, transient: true }))).toMatchObject({ kind });
    }
  });

  it("refuses a completion larger than the cap without retrying", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.setHeader("Content-Type", "application/json");
      // Chunked (no Content-Length), so the streamed count has to catch it.
      res.write(`{"choices":[{"message":{"content":"`);
      res.write("x".repeat(MAX_COMPLETION_BYTES));
      res.end(`"}}]}`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const err = await planMoments(payload(), { provider: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "test/model" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LLMError);
    expect((err as Error).message).toBe(MODEL_ERROR.tooLarge);
    expect(requests).toBe(1);
  });
});

/** A provider that always fails, without retries (an over-size completion is not retried). */
async function brokenProvider() {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(`{"choices":[{"message":{"content":"${"x".repeat(MAX_COMPLETION_BYTES)}"}}]}`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { provider: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "test/model" }, requests: () => requests };
}

describe("planMoments when the provider fails", () => {
  it("still rejects by default", async () => {
    const { provider } = await brokenProvider();
    await expect(planMoments(payload(), { provider })).rejects.toBeInstanceOf(LLMError);
  });

  it('keeps the rule moments with onModelFailure: "rules" and says why', async () => {
    const { provider, requests } = await brokenProvider();
    const rulesOnly = await planMoments(payload());
    const r = await planMoments(payload(), { provider, onModelFailure: "rules" });
    expect(requests()).toBe(1);
    expect(r.planner).toBe("rules");
    expect(r.modelFallback).toBe("provider_error");
    expect(r.plan).toEqual(rulesOnly.plan);
    expect(v2(r.plan).find((m) => m.source === "flare")).toBeDefined();
  });

  it("does not fall back when the call was cancelled", async () => {
    const { provider } = await brokenProvider();
    const ac = new AbortController();
    ac.abort();
    await expect(planMoments(payload(), { provider, signal: ac.signal, onModelFailure: "rules" })).rejects.toBeDefined();
  });
});

describe("long captures", () => {
  // A 10-minute take: the pointer sampled at 20 Hz, plus clicks and a held key.
  function tenMinutes(): LocalMomentInput["interactions"] {
    const events: LocalMomentInput["interactions"] = [];
    for (let i = 0; i < 12_000; i++) {
      const t = i * 50;
      events.push({ kind: "move", time_ms: t, x: 100 + (i % 500), y: 200 });
      if (i % 600 === 300) events.push({ kind: "down", time_ms: t, x: 100 + (i % 500), y: 200, button: 0 }, { kind: "up", time_ms: t + 20, x: 100 + (i % 500), y: 200, button: 0 });
      if (i % 2000 === 1000) events.push({ kind: "key_down", time_ms: t, key_code: 59 }, { kind: "key_up", time_ms: t + 900, key_code: 59 });
    }
    return events;
  }

  it("thins pointer moves to the planner's limit and keeps every click and key", () => {
    const events = tenMinutes();
    const bounded = boundInteractions(events);
    expect(bounded).toHaveLength(MAX_PLANNER_INTERACTIONS);
    const edges = (list: typeof events) => list.filter((e) => e.kind !== "move");
    expect(edges(bounded)).toEqual(edges(events));
    // Original order, as a subsequence of the input.
    const at = bounded.map((e) => events.indexOf(e));
    expect(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1]))).toBe(true);
    // Within the limit nothing changes.
    const short = events.slice(0, 500);
    expect(boundInteractions(short)).toBe(short);
  });

  it("plans a 10-minute take instead of rejecting it", async () => {
    const interactions = tenMinutes();
    expect(interactions.length).toBeGreaterThan(MAX_PLANNER_INTERACTIONS);
    const { plan } = await planMoments({
      schemaVersion: 2,
      durationMs: 600_000,
      transcript: [],
      interactions,
      clickElements: [],
      interactionSelection: "bounded sample; full stream retained locally",
    });
    expect(v2(plan).some((m) => m.source === "click")).toBe(true);
  });
});

describe("long typing sessions", () => {
  // 20 minutes of typing (8 keys a second) with Control holds, Ctrl+C chords
  // and pen sessions: the key events alone are far past the planner's limit.
  function typing(): LocalMomentInput["interactions"] {
    const events: LocalMomentInput["interactions"] = [];
    const letters = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 31, 32, 34, 35, 37, 38, 40, 45, 46, 49];
    let n = 0;
    for (let t = 0; t < 1_200_000; t += 125) {
      const s = t % 60_000;
      if (s === 10_000) {
        events.push({ kind: "key_down", time_ms: t, key_code: 59 }, { kind: "key_up", time_ms: t + 1_500, key_code: 59 }); // a flare
        continue;
      }
      if (s === 30_000) {
        // Ctrl+C: a chord, never a flare.
        events.push(
          { kind: "key_down", time_ms: t, key_code: 59 },
          { kind: "key_down", time_ms: t + 300, key_code: 8 },
          { kind: "key_up", time_ms: t + 350, key_code: 8 },
          { kind: "key_up", time_ms: t + 700, key_code: 59 },
        );
        continue;
      }
      if (s === 45_000) events.push({ kind: "annotation", time_ms: t, active: true }, { kind: "annotation", time_ms: t + 4_000, active: false });
      if (s > 10_000 && s < 12_000) continue; // hands off the keys during the flare
      const code = letters[n++ % letters.length];
      events.push({ kind: "key_down", time_ms: t, key_code: code }, { kind: "key_up", time_ms: t + 60, key_code: code });
      events.push({ kind: "move", time_ms: t, x: 100 + (n % 300), y: 200 });
    }
    return events;
  }
  const asCursor = (list: LocalMomentInput["interactions"]) =>
    list.map((e) => ({ ...e, key_code: e.key_code ?? null, active: e.active ?? null })) as unknown as Parameters<typeof detectFlareSpans>[0];

  it("keeps every flare, chord and pen session when the key events alone pass the limit", () => {
    const events = typing();
    const keys = events.filter((e) => e.kind === "key_down" || e.kind === "key_up");
    expect(keys.length).toBeGreaterThan(MAX_PLANNER_INTERACTIONS);
    const bounded = boundInteractions(events);
    expect(bounded.length).toBeLessThanOrEqual(MAX_PLANNER_INTERACTIONS);
    const flares = detectFlareSpans(asCursor(events));
    expect(flares).toHaveLength(20);
    expect(detectFlareSpans(asCursor(bounded))).toEqual(flares);
    expect(detectAnnotationSpans(asCursor(bounded), 1_200_000)).toEqual(detectAnnotationSpans(asCursor(events), 1_200_000));
    // Key presses outside a Control hold survive only as whole pairs.
    const holds: Array<[number, number]> = [];
    for (const e of events) {
      if (e.key_code !== 59) continue;
      if (e.kind === "key_down") holds.push([e.time_ms, Infinity]);
      else holds[holds.length - 1][1] = e.time_ms;
    }
    const inHold = (t: number) => holds.some(([a, b]) => t >= a && t <= b);
    const kept = new Set(bounded);
    const pairs = events.filter((e) => e.kind === "key_down" && e.key_code !== 59 && !inHold(e.time_ms));
    for (const down of pairs) {
      const up = events.find((e) => e.kind === "key_up" && e.key_code === down.key_code && e.time_ms === down.time_ms + 60)!;
      expect(kept.has(down)).toBe(kept.has(up));
    }
    expect(pairs.some((d) => kept.has(d))).toBe(true);
  });
});

describe("stripCodeFence", () => {
  it.each(fenceCases)("$name", ({ input, expected }) => {
    expect(stripCodeFence(input)).toBe(expected);
  });

  it("accepts prose-wrapped fenced JSON responses from a provider", async () => {
    const wrapped = `Here are the moments:\n\n\`\`\`json\n${JSON.stringify({ moments: fixture.llmMoments })}\n\`\`\``;
    const { baseUrl } = await fakeProvider(wrapped, { rawContent: true });
    const { plan, planner } = await planMoments(payload(), {
      provider: { baseUrl, apiKey: "test-key", model: "test/model" },
    });
    expect(planner).toBe("rules+model");
    const moments = v2(plan);
    const spoken = moments.filter((m) => m.source === "spoken" || m.source === "fused" || m.source === "hover");
    expect(spoken.map((m) => m.timestamp_ms)).toEqual(expect.arrayContaining([10_120, 15_190, 25_130]));
  });
});
