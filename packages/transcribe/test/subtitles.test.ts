import { describe, expect, it } from "vitest";
import { toSrt, toVtt } from "../src/index.js";
import type { TranscriptSegment } from "../src/types.js";

describe("subtitle formatters", () => {
  it("formats timestamps and numbers SRT cues from one", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 1_234, endMs: 5_678, text: "First cue" },
      { startMs: 8_901, endMs: 9_999, text: "Second cue" },
    ];

    expect(toSrt(segments)).toBe(
      "1\n00:00:01,234 --> 00:00:05,678\nFirst cue\n\n" +
        "2\n00:00:08,901 --> 00:00:09,999\nSecond cue",
    );
  });

  it("keeps hours beyond a day from wrapping", () => {
    expect(toSrt([{ startMs: 90_061_007, endMs: 90_062_008, text: "Long take" }])).toBe(
      "1\n25:01:01,007 --> 25:01:02,008\nLong take",
    );
    expect(toVtt([{ startMs: 90_061_007, endMs: 90_062_008, text: "Long take" }])).toBe(
      "WEBVTT\n\n25:01:01.007 --> 25:01:02.008\nLong take",
    );
  });

  it("pads milliseconds and uses WebVTT timestamp punctuation", () => {
    const segments: TranscriptSegment[] = [{ startMs: 1, endMs: 42, text: "Short cue" }];
    expect(toSrt(segments)).toBe("1\n00:00:00,001 --> 00:00:00,042\nShort cue");
    expect(toVtt(segments)).toBe("WEBVTT\n\n00:00:00.001 --> 00:00:00.042\nShort cue");
  });

  it("returns valid empty output for empty segment lists", () => {
    expect(toSrt([])).toBe("");
    expect(toVtt([])).toBe("WEBVTT\n\n");
  });
});
