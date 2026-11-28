import { describe, expect, it } from "vitest";
import { formatSrtTimestamp, formatVttTimestamp, toSrt, toVtt } from "../src/subtitles.js";
import { toSrt as exportedToSrt, toVtt as exportedToVtt } from "../src/index.js";
import type { TranscriptSegment } from "../src/types.js";

describe("formatSrtTimestamp", () => {
  it("formats zero milliseconds", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
  });

  it("pads single-digit and double-digit milliseconds with zeros", () => {
    expect(formatSrtTimestamp(7)).toBe("00:00:00,007");
    expect(formatSrtTimestamp(42)).toBe("00:00:00,042");
    expect(formatSrtTimestamp(999)).toBe("00:00:00,999");
  });

  it("formats seconds, minutes, and hours accurately", () => {
    expect(formatSrtTimestamp(1_000)).toBe("00:00:01,000");
    expect(formatSrtTimestamp(60_000)).toBe("00:01:00,000");
    expect(formatSrtTimestamp(3_600_000)).toBe("01:00:00,000");
    // 1 hr, 23 min, 45 sec, 678 ms
    const timeMs = 1 * 3_600_000 + 23 * 60_000 + 45 * 1_000 + 678;
    expect(formatSrtTimestamp(timeMs)).toBe("01:23:45,678");
  });

  it("handles multi-hour and large durations without drift", () => {
    // 12 hours, 34 minutes, 56 seconds, 789 ms
    const largeMs = 12 * 3_600_000 + 34 * 60_000 + 56 * 1_000 + 789;
    expect(formatSrtTimestamp(largeMs)).toBe("12:34:56,789");
  });

  it("handles negative numbers, non-finite values, and fractional milliseconds safely", () => {
    expect(formatSrtTimestamp(-500)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(Number.NaN)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(Number.POSITIVE_INFINITY)).toBe("00:00:00,000");
    // Floats are floored
    expect(formatSrtTimestamp(1500.85)).toBe("00:00:01,500");
  });
});

describe("formatVttTimestamp", () => {
  it("formats zero milliseconds with a period separator", () => {
    expect(formatVttTimestamp(0)).toBe("00:00:00.000");
  });

  it("pads milliseconds and converts timestamps with dot separator", () => {
    expect(formatVttTimestamp(5)).toBe("00:00:00.005");
    expect(formatVttTimestamp(99)).toBe("00:00:00.099");
    const timeMs = 2 * 3_600_000 + 15 * 60_000 + 30 * 1_000 + 250;
    expect(formatVttTimestamp(timeMs)).toBe("02:15:30.250");
  });

  it("handles multi-hour durations", () => {
    expect(formatVttTimestamp(100 * 3_600_000)).toBe("100:00:00.000");
  });
});

describe("toSrt", () => {
  it("returns empty string for empty or whitespace-only inputs", () => {
    expect(toSrt([])).toBe("");
    expect(toSrt([{ startMs: 0, endMs: 1000, text: "" }])).toBe("");
    expect(toSrt([{ startMs: 0, endMs: 1000, text: "   \n\t  " }])).toBe("");
  });

  it("formats a single segment with 1-based cue index and comma separator", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 1200, endMs: 4500, text: "Hello, world!" },
    ];
    const expected = "1\n00:00:01,200 --> 00:00:04,500\nHello, world!\n";
    expect(toSrt(segments)).toBe(expected);
  });

  it("formats multiple segments separated by blank lines", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 0, endMs: 2500, text: "First caption." },
      { startMs: 3000, endMs: 6200, text: "Second caption." },
      { startMs: 7000, endMs: 9500, text: "Third caption." },
    ];
    const expected =
      "1\n00:00:00,000 --> 00:00:02,500\nFirst caption.\n\n" +
      "2\n00:00:03,000 --> 00:00:06,200\nSecond caption.\n\n" +
      "3\n00:00:07,000 --> 00:00:09,500\nThird caption.\n";
    expect(toSrt(segments)).toBe(expected);
  });

  it("sorts segments monotonically by startMs", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 5000, endMs: 8000, text: "Later sentence." },
      { startMs: 1000, endMs: 3000, text: "Earlier sentence." },
    ];
    const srt = toSrt(segments);
    expect(srt).toContain("1\n00:00:01,000 --> 00:00:03,000\nEarlier sentence.");
    expect(srt).toContain("2\n00:00:05,000 --> 00:00:08,000\nLater sentence.");
  });

  it("clamps endMs to startMs if endMs is before startMs", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 5000, endMs: 2000, text: "Inverted interval." },
    ];
    const srt = toSrt(segments);
    expect(srt).toBe("1\n00:00:05,000 --> 00:00:05,000\nInverted interval.\n");
  });

  it("normalizes CRLF to LF in multi-line subtitle text", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 0, endMs: 2000, text: "Line 1\r\nLine 2\r\nLine 3" },
    ];
    const expected = "1\n00:00:00,000 --> 00:00:02,000\nLine 1\nLine 2\nLine 3\n";
    expect(toSrt(segments)).toBe(expected);
  });

  it("filters out empty segments without breaking sequential numbering", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 100, endMs: 1000, text: "First" },
      { startMs: 1200, endMs: 2000, text: "   " },
      { startMs: 2500, endMs: 3500, text: "Second" },
    ];
    const srt = toSrt(segments);
    expect(srt).toBe(
      "1\n00:00:00,100 --> 00:00:01,000\nFirst\n\n" +
      "2\n00:00:02,500 --> 00:00:03,500\nSecond\n"
    );
  });
});

describe("toVtt", () => {
  it("returns WEBVTT header for empty input", () => {
    expect(toVtt([])).toBe("WEBVTT\n");
    expect(toVtt([{ startMs: 0, endMs: 1000, text: "  " }])).toBe("WEBVTT\n");
  });

  it("formats single cue with WEBVTT header and dot separator", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 500, endMs: 3000, text: "Welcome to Clipy!" },
    ];
    const expected =
      "WEBVTT\n\n" +
      "1\n00:00:00.500 --> 00:00:03.000\nWelcome to Clipy!\n";
    expect(toVtt(segments)).toBe(expected);
  });

  it("formats multiple cues accurately", () => {
    const segments: TranscriptSegment[] = [
      { startMs: 0, endMs: 2000, text: "Step one." },
      { startMs: 2500, endMs: 4500, text: "Step two." },
    ];
    const expected =
      "WEBVTT\n\n" +
      "1\n00:00:00.000 --> 00:00:02.000\nStep one.\n\n" +
      "2\n00:00:02.500 --> 00:00:04.500\nStep two.\n";
    expect(toVtt(segments)).toBe(expected);
  });
});

describe("Package exports", () => {
  it("exports toSrt and toVtt from package index", () => {
    expect(typeof exportedToSrt).toBe("function");
    expect(typeof exportedToVtt).toBe("function");
    expect(exportedToSrt([{ startMs: 0, endMs: 1000, text: "Hi" }])).toContain("00:00:00,000");
    expect(exportedToVtt([{ startMs: 0, endMs: 1000, text: "Hi" }])).toContain("WEBVTT");
  });
});
