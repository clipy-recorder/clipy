import type { TranscriptSegment } from "./types.js";

function timestamp(milliseconds: number, separator: "," | "."): string {
  const totalMs = Math.max(0, Math.trunc(milliseconds));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const ms = totalMs % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(ms).padStart(3, "0")}`;
}

/** Format timestamped transcript segments as SubRip subtitles. */
export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((segment, index) => `${index + 1}\n${timestamp(segment.startMs, ",")} --> ${timestamp(segment.endMs, ",")}\n${segment.text}`)
    .join("\n\n");
}

/** Format timestamped transcript segments as WebVTT subtitles. */
export function toVtt(segments: TranscriptSegment[]): string {
  const cues = segments
    .map((segment) => `${timestamp(segment.startMs, ".")} --> ${timestamp(segment.endMs, ".")}\n${segment.text}`)
    .join("\n\n");
  return cues ? `WEBVTT\n\n${cues}` : "WEBVTT\n\n";
}
