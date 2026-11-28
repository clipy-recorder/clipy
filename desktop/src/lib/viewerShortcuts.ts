/** How far Left and Right arrow keys step through the recording. */
export const SEEK_STEP_MS = 5_000;

/** Tolerance for floating-point seconds-to-milliseconds conversion jitter. */
const MOMENT_EPSILON_MS = 50;

/**
 * When playback is running, pressing `[` right after jumping to a moment steps
 * back to the previous moment instead of snapping back to the current one.
 */
export const MOMENT_BACK_GRACE_MS = 800;

export type ViewerShortcutCommand =
  | { type: "togglePlay" }
  | { type: "seekRelative"; deltaMs: number }
  | { type: "seekMoment"; direction: -1 | 1 }
  | { type: "toggleHelp" }
  | { type: "closeHelp" };

export interface ShortcutTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  dataset?: Record<string, string | undefined>;
  closest?: (selector: string) => unknown;
}

export interface ShortcutKeyEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}

const TEXT_FIELD_SELECTOR = "input, textarea, select";
const INTERACTIVE_CONTROL_SELECTOR = 'button, a[href], summary, [role="button"], [role="link"]';

function asTargetLike(target: unknown): ShortcutTargetLike | null {
  if (!target || typeof target !== "object") return null;
  return target as ShortcutTargetLike;
}

/** True when focus is inside a text field or content-editable region. */
export function isTextInputTarget(target: unknown): boolean {
  const el = asTargetLike(target);
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (typeof el.closest === "function") {
    return el.closest(TEXT_FIELD_SELECTOR) != null;
  }
  return false;
}

/**
 * True when Space should activate a focused UI button (such as Copy or ?)
 * rather than toggling video playback. Focused seek rows (moments and
 * transcript lines) and the <video> element still map Space to play/pause.
 */
function shouldLetControlHandleSpace(target: unknown): boolean {
  const el = asTargetLike(target);
  if (!el) return false;
  if (typeof el.closest === "function") {
    const seekItem = el.closest("[data-viewer-seek]") as ShortcutTargetLike | null | undefined;
    if (seekItem) return false;
    const control = el.closest(INTERACTIVE_CONTROL_SELECTOR);
    if (control) return true;
  }
  const tag = el.tagName?.toUpperCase();
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") {
    return el.dataset?.viewerSeek !== "true";
  }
  return false;
}

/** Maps a window keydown event in the viewer to its command, or null if ignored. */
export function resolveViewerShortcut(
  event: ShortcutKeyEventLike,
  options: { helpOpen: boolean },
): ViewerShortcutCommand | null {
  if (event.defaultPrevented) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTextInputTarget(event.target)) return null;

  if (event.key === "Escape" && options.helpOpen) {
    return { type: "closeHelp" };
  }

  if (event.key === "?") {
    return { type: "toggleHelp" };
  }

  if (event.key === "ArrowLeft" && !event.shiftKey) {
    return { type: "seekRelative", deltaMs: -SEEK_STEP_MS };
  }

  if (event.key === "ArrowRight" && !event.shiftKey) {
    return { type: "seekRelative", deltaMs: SEEK_STEP_MS };
  }

  if (event.key === "[") {
    return { type: "seekMoment", direction: -1 };
  }

  if (event.key === "]") {
    return { type: "seekMoment", direction: 1 };
  }

  if ((event.key === " " || event.code === "Space") && !event.shiftKey) {
    if (shouldLetControlHandleSpace(event.target)) return null;
    return { type: "togglePlay" };
  }

  return null;
}

/** Clamps a target playback position in milliseconds within [0, durationMs]. */
export function clampSeekMs(targetMs: number, durationMs: number): number {
  const max = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  if (!Number.isFinite(targetMs)) return 0;
  return Math.min(max, Math.max(0, targetMs));
}

/**
 * Returns the timestamp (ms) of the previous or next key moment relative to
 * `currentMs`, or null when already before the first or at/after the last.
 */
export function findAdjacentMomentMs(
  timestampsMs: readonly number[],
  currentMs: number,
  direction: -1 | 1,
  graceMs = 0,
): number | null {
  const sorted = Array.from(new Set(timestampsMs.filter(Number.isFinite))).sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  const pos = Number.isFinite(currentMs) ? currentMs : 0;

  if (direction === 1) {
    for (const ts of sorted) {
      if (ts > pos + MOMENT_EPSILON_MS) return ts;
    }
    return null;
  }

  let latestIdx = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] <= pos + MOMENT_EPSILON_MS) {
      latestIdx = i;
    } else {
      break;
    }
  }
  if (latestIdx < 0) return null;

  const threshold = Math.max(MOMENT_EPSILON_MS, graceMs);
  if (pos - sorted[latestIdx] <= threshold) {
    return latestIdx > 0 ? sorted[latestIdx - 1] : null;
  }
  return sorted[latestIdx];
}
