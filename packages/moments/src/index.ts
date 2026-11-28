/**
 * @clipy/moments: picks the moments of a screen recording worth a screenshot.
 *
 * The same detectors and planner Clipy's hosted service runs, packaged to run
 * on the user's machine:
 * - Rules (always, offline): hold-to-highlight flares, pen drawings, click
 *   clusters and pointer rests from the interaction sidecar.
 * - Spoken cues (optional): a model reads the transcript for "this button",
 *   "it breaks here" and similar, using the provider the user configured.
 */
import { runWithModelProvider, type ModelProvider } from "./llm.js";
import { detectFlareSpans, type CursorEvent } from "./generated/keyMomentsCursorContext.js";
import { FLARE_SAMPLE_MAX_GAP_MS, FLARE_TRAIL_LEAD_MS } from "./generated/keyMomentsFusion.js";
import {
  describePlannerError,
  localMomentInput,
  planLocalMoments,
  type LocalMomentInput,
  type LocalMomentPlan,
} from "./generated/localMomentPlan.js";

export {
  DEFAULT_OPENROUTER_MODEL,
  PROVIDER_BASE_URLS,
  LLMError,
  MODEL_ERROR,
  type ModelProvider,
} from "./llm.js";
export {
  localMomentInput,
  describePlannerError,
  isTransientPlannerError,
  type LocalMoment,
  type LocalMomentInput,
  type LocalMomentPlan,
  type LocalMomentSource,
} from "./generated/localMomentPlan.js";

export interface PlanOptions {
  /** null or omitted: rules only, nothing leaves the machine. */
  provider?: ModelProvider | null;
  signal?: AbortSignal;
  /**
   * When the model provider still fails after the planner's retries:
   * "throw" (default) rejects; "rules" plans again on rules alone and says so
   * in `modelFallback`, so a provider outage never costs the gesture moments.
   */
  onModelFailure?: "throw" | "rules";
}

/** Which planner produced a plan, for the AREC to state. */
export type PlannerUsed = "rules" | "rules+model";

export interface PlanResult {
  plan: LocalMomentPlan;
  planner: PlannerUsed;
  /** Set only with `onModelFailure: "rules"` after the provider failed: the failure's kind (see describePlannerError). */
  modelFallback?: string;
}

/** The planner's limit on interaction events. */
export const MAX_PLANNER_INTERACTIONS = 8000;

/** Button, key and annotation edges: the evidence every gesture rule reads. */
const EDGE_KINDS = new Set(["down", "up", "key_down", "key_up", "annotation"]);

function evenly(indices: number[], budget: number): number[] {
  if (budget <= 0) return [];
  if (indices.length <= budget) return indices;
  const out: number[] = [];
  for (let k = 0; k < budget; k++) out.push(indices[Math.floor((k * indices.length) / budget)]);
  return out;
}

/** macOS Control key codes, the hold-to-highlight key (the local planner reads Mac key codes). */
const CONTROL_KEYCODES = new Set([59, 62]);
/** macOS modifier key codes: pressing one during a Control hold does not make it a chord. */
const isModifierKeycode = (code: number) => code >= 54 && code <= 63;

interface EdgeEvent {
  kind?: unknown;
  time_ms?: unknown;
  key_code?: unknown;
  button?: unknown;
  x?: unknown;
  y?: unknown;
}

/**
 * Button, key and annotation events thinned to `budget` without changing
 * what the gesture rules see: every Control and annotation event, and every
 * non-modifier key press during a Control hold (it makes a chord), are kept;
 * other key presses and clicks are dropped only as whole down/up pairs.
 */
function thinEdges<T>(events: readonly T[], edges: number[], budget: number): number[] {
  if (edges.length <= budget) return edges;
  const at = (i: number) => events[i] as EdgeEvent;
  const time = (i: number) => (typeof at(i).time_ms === "number" ? (at(i).time_ms as number) : 0);
  const ordered = [...edges].sort((a, b) => time(a) - time(b) || a - b);
  const kept: number[] = [];
  const units: number[][] = [];
  const openKeys = new Map<unknown, number[]>();
  const openButtons = new Map<unknown, number[]>();
  let held = 0;
  for (const i of ordered) {
    const e = at(i);
    const code = e.key_code;
    if (e.kind === "annotation") {
      kept.push(i);
    } else if ((e.kind === "key_down" || e.kind === "key_up") && typeof code === "number" && CONTROL_KEYCODES.has(code)) {
      kept.push(i);
      held = e.kind === "key_down" ? held + 1 : 0;
    } else if (e.kind === "key_down" && held > 0 && typeof code === "number" && !isModifierKeycode(code)) {
      kept.push(i);
    } else if (e.kind === "key_down" || e.kind === "down") {
      const open = e.kind === "key_down" ? openKeys : openButtons;
      const id = e.kind === "key_down" ? code : e.button;
      const unit = [i];
      units.push(unit);
      if (!open.has(id)) open.set(id, []);
      open.get(id)!.push(units.length - 1);
    } else {
      const open = e.kind === "key_up" ? openKeys : openButtons;
      const id = e.kind === "key_up" ? code : e.button;
      const pending = open.get(id);
      const unitIndex = pending?.shift();
      if (unitIndex !== undefined) units[unitIndex].push(i);
      else units.push([i]);
    }
  }
  if (kept.length >= budget) return evenly(kept, budget);
  const room = budget - kept.length;
  const size = (list: number[][]) => list.reduce((n, u) => n + u.length, 0);
  let count = Math.min(units.length, room);
  let chosen = evenly(units.map((_u, k) => k), count).map((k) => units[k]);
  while (size(chosen) > room && count > 0) {
    count = Math.max(0, count - Math.ceil((size(chosen) - room) / 2));
    chosen = evenly(units.map((_u, k) => k), count).map((k) => units[k]);
  }
  return [...kept, ...chosen.flat()];
}

/**
 * Pick the index of the move event that `flarePosition(moves, atMs)` will
 * select: nearest sample within `FLARE_SAMPLE_MAX_GAP_MS` (matching
 * `cursorPositionAt`), falling back to the latest sample at or before `atMs`
 * (matching `cursorPositionBefore`).
 */
function flareMoveIndex(moves: readonly { index: number; tMs: number }[], atMs: number): number | null {
  if (moves.length === 0) return null;
  let lo = 0;
  let hi = moves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (moves[mid].tMs < atMs) lo = mid + 1;
    else hi = mid;
  }
  let best = moves[lo];
  const previous = lo > 0 ? moves[lo - 1] : undefined;
  if (previous && Math.abs(previous.tMs - atMs) < Math.abs(best.tMs - atMs)) best = previous;
  if (Math.abs(best.tMs - atMs) <= FLARE_SAMPLE_MAX_GAP_MS) return best.index;

  let bLo = 0;
  let bHi = moves.length;
  while (bLo < bHi) {
    const mid = (bLo + bHi) >> 1;
    if (moves[mid].tMs <= atMs) bLo = mid + 1;
    else bHi = mid;
  }
  return bLo > 0 ? moves[bLo - 1].index : null;
}

/**
 * Find the pointer move indices required to anchor every Control-hold flare,
 * plus the count of essential edges (annotations, Control keys, and chord
 * presses/releases) so anchor moves never evict essential edges.
 */
function flareAnchorMoves<T>(
  events: readonly T[],
  edges: readonly number[],
  rest: readonly number[],
  durationMs?: number,
): { anchors: number[]; essentialEdges: number } {
  if (rest.length === 0) return { anchors: [], essentialEdges: 0 };
  const at = (i: number) => events[i] as EdgeEvent;
  const hasControl = edges.some((i) => {
    const e = at(i);
    return (e.kind === "key_down" || e.kind === "key_up") && typeof e.key_code === "number" && CONTROL_KEYCODES.has(e.key_code);
  });
  if (!hasControl) return { anchors: [], essentialEdges: 0 };
  const maxTime = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : Infinity;
  const time = (i: number) => (typeof at(i).time_ms === "number" ? (at(i).time_ms as number) : 0);
  const orderedEdges = [...edges].sort((a, b) => time(a) - time(b) || a - b);

  let essentialEdges = 0;
  let held = 0;
  const openChordKeys = new Map<number, number>();
  const keyEvents: CursorEvent[] = [];

  for (const i of orderedEdges) {
    const e = at(i);
    const code = e.key_code;
    if (e.kind === "annotation") {
      essentialEdges += 1;
    } else if ((e.kind === "key_down" || e.kind === "key_up") && typeof code === "number" && CONTROL_KEYCODES.has(code)) {
      essentialEdges += 1;
      held = e.kind === "key_down" ? held + 1 : 0;
    } else if (e.kind === "key_down" && held > 0 && typeof code === "number" && !isModifierKeycode(code)) {
      essentialEdges += 1;
      openChordKeys.set(code, (openChordKeys.get(code) ?? 0) + 1);
    } else if (e.kind === "key_up" && typeof code === "number") {
      const open = openChordKeys.get(code) ?? 0;
      if (open > 0) {
        essentialEdges += 1;
        if (open === 1) openChordKeys.delete(code);
        else openChordKeys.set(code, open - 1);
      }
    }

    if ((e.kind === "key_down" || e.kind === "key_up") && typeof e.time_ms === "number" && Number.isFinite(e.time_ms) && e.time_ms >= 0 && e.time_ms <= maxTime) {
      keyEvents.push({
        kind: e.kind,
        time_ms: e.time_ms,
        x: null,
        y: null,
        delta_x: null,
        delta_y: null,
        key_code: typeof code === "number" && Number.isFinite(code) ? code : null,
        button: null,
        cursor_type: null,
        active: null,
      });
    }
  }

  const flares = detectFlareSpans(keyEvents);
  if (flares.length === 0) return { anchors: [], essentialEdges };

  const moves: Array<{ index: number; tMs: number }> = [];
  for (const i of rest) {
    const e = at(i);
    if (
      e.kind === "move" &&
      typeof e.time_ms === "number" &&
      Number.isFinite(e.time_ms) &&
      e.time_ms >= 0 &&
      e.time_ms <= maxTime &&
      typeof e.x === "number" &&
      Number.isFinite(e.x) &&
      typeof e.y === "number" &&
      Number.isFinite(e.y)
    ) {
      moves.push({ index: i, tMs: e.time_ms });
    }
  }
  if (moves.length === 0) return { anchors: [], essentialEdges };
  moves.sort((a, b) => a.tMs - b.tMs || a.index - b.index);

  const anchorSet = new Set<number>();
  for (const flare of flares) {
    const rawAt = Math.max(flare.startMs, flare.endMs - FLARE_TRAIL_LEAD_MS);
    const atMs = maxTime < Infinity ? Math.min(rawAt, maxTime) : rawAt;
    const idx = flareMoveIndex(moves, atMs);
    if (idx !== null) anchorSet.add(idx);
  }
  return { anchors: [...anchorSet].sort((a, b) => a - b), essentialEdges };
}

function boundInteractionsFor<T>(events: readonly T[], limit: number, durationMs?: number): T[] {
  if (events.length <= limit) return events as T[];
  const kindOf = (e: T) => (e && typeof e === "object" ? (e as { kind?: unknown }).kind : undefined);
  const edges: number[] = [];
  const scrolls: number[] = [];
  const rest: number[] = [];
  events.forEach((e, i) => {
    const kind = kindOf(e);
    if (typeof kind === "string" && EDGE_KINDS.has(kind)) edges.push(i);
    else if (kind === "scroll") scrolls.push(i);
    else rest.push(i);
  });
  const { anchors, essentialEdges } = flareAnchorMoves(events, edges, rest, durationMs);
  const anchorRoom =
    edges.length > limit
      ? Math.max(0, limit - essentialEdges)
      : Math.max(0, limit - edges.length);
  const keptAnchors = evenly(anchors, Math.min(anchors.length, anchorRoom));
  const keptEdges = thinEdges(events, edges, limit - keptAnchors.length);
  const keptScrolls = evenly(scrolls, limit - keptEdges.length - keptAnchors.length);
  const anchorSet = new Set(keptAnchors);
  const remainingRest = anchorSet.size > 0 ? rest.filter((i) => !anchorSet.has(i)) : rest;
  const keptRest = evenly(remainingRest, limit - keptEdges.length - keptAnchors.length - keptScrolls.length);
  const keep = new Set([...keptEdges, ...keptAnchors, ...keptScrolls, ...keptRest]);
  return events.filter((_e, i) => keep.has(i));
}

/**
 * Interactions thinned to `limit`, in their original order: button, key and
 * annotation events first (thinned only when they alone pass the limit, see
 * thinEdges) while reserving the pointer move sample each Control-hold flare
 * needs for its position, then scrolls, and remaining pointer moves thinned
 * evenly into what is left. Within the limit the array comes back unchanged.
 * (A 20 Hz pointer track passes 8000 events in under seven minutes.)
 */
export function boundInteractions<T>(events: readonly T[], limit = MAX_PLANNER_INTERACTIONS): T[] {
  return boundInteractionsFor(events, limit);
}

export async function planMoments(input: LocalMomentInput, options: PlanOptions = {}): Promise<PlanResult> {
  const raw = input as { interactions?: unknown; durationMs?: unknown };
  const durationMs = typeof raw.durationMs === "number" ? raw.durationMs : undefined;
  const bounded =
    Array.isArray(raw.interactions) && raw.interactions.length > MAX_PLANNER_INTERACTIONS
      ? { ...input, interactions: boundInteractionsFor(input.interactions, MAX_PLANNER_INTERACTIONS, durationMs) }
      : input;
  const parsed = localMomentInput.parse(bounded);
  const provider = options.provider ?? null;
  const signal = options.signal ?? new AbortController().signal;
  try {
    // Scoped to this call, so concurrent calls with different providers are safe.
    const { result: plan, modelAnswers } = await runWithModelProvider(provider, () => planLocalMoments(parsed, signal));
    // "rules+model" only when a model's answer went into the plan: with an
    // empty transcript the model is never asked, whatever is configured.
    return { plan, planner: modelAnswers > 0 ? "rules+model" : "rules" };
  } catch (error) {
    if (!provider || options.onModelFailure !== "rules" || signal.aborted) throw error;
    const { result: plan } = await runWithModelProvider(null, () => planLocalMoments(parsed, signal));
    return { plan, planner: "rules", modelFallback: String(describePlannerError(error).kind ?? "error") };
  }
}
