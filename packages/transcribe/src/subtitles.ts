/**
 * Pure, zero-dependency subtitle formatting utilities for @clipy/transcribe.
 * Converts timestamped TranscriptSegment arrays into standard SubRip (.srt)
 * and WebVTT (.vtt) subtitle file contents.
 */
import type { TranscriptSegment } from "./types.js";

/** Formats milliseconds into SRT timestamp format: HH:MM:SS,mmm */
export function formatSrtTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.floor(Number.isFinite(ms) ? ms : 0));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1_000);
  const millis = safeMs % 1_000;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");

  return `${hh}:${mm}:${ss},${mmm}`;
}

/** Formats milliseconds into WebVTT timestamp format: HH:MM:SS.mmm */
export function formatVttTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.floor(Number.isFinite(ms) ? ms : 0));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1_000);
  const millis = safeMs % 1_000;

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  const mmm = String(millis).padStart(3, "0");

  return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * Converts transcript segments into SubRip (.srt) subtitle format.
 *
 * Rules:
 * - 1-based sequential cue numbering.
 * - Time format: `00:00:00,000 --> 00:00:00,000`
 * - Empty segments or whitespace-only texts are omitted.
 * - Sorted monotonically by start time.
 * - Empty input produces an empty string.
 */
export function toSrt(segments: readonly TranscriptSegment[]): string {
  const valid = segments
    .filter((s) => s && typeof s.text === "string" && s.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);

  if (valid.length === 0) return "";

  const blocks: string[] = [];

  for (let i = 0; i < valid.length; i++) {
    const cueIndex = i + 1;
    const seg = valid[i];
    const start = formatSrtTimestamp(seg.startMs);
    const endMs = Math.max(seg.startMs, seg.endMs);
    const end = formatSrtTimestamp(endMs);
    const text = seg.text.trim().replace(/\r\n/g, "\n");

    blocks.push(`${cueIndex}\n${start} --> ${end}\n${text}`);
  }

  return blocks.join("\n\n") + "\n";
}

/**
 * Converts transcript segments into WebVTT (.vtt) subtitle format.
 *
 * Rules:
 * - Starts with the `WEBVTT` header.
 * - Time format: `00:00:00.000 --> 00:00:00.000`
 * - Empty segments or whitespace-only texts are omitted.
 * - Sorted monotonically by start time.
 * - Empty input produces "WEBVTT\n".
 */
export function toVtt(segments: readonly TranscriptSegment[]): string {
  const valid = segments
    .filter((s) => s && typeof s.text === "string" && s.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);

  if (valid.length === 0) return "WEBVTT\n";

  const cues: string[] = [];

  for (let i = 0; i < valid.length; i++) {
    const cueIndex = i + 1;
    const seg = valid[i];
    const start = formatVttTimestamp(seg.startMs);
    const endMs = Math.max(seg.startMs, seg.endMs);
    const end = formatVttTimestamp(endMs);
    const text = seg.text.trim().replace(/\r\n/g, "\n");

    cues.push(`${cueIndex}\n${start} --> ${end}\n${text}`);
  }

  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}
