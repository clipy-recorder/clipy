import { describe, expect, it } from "vitest";
import { GeminiTranscript } from "../src/providers/gemini.js";

describe("GeminiTranscript and Seconds schema parsing", () => {
  it("parses raw numeric seconds", () => {
    const parsed = GeminiTranscript.parse({
      language: "en",
      segments: [
        { start: 0, end: 1.5, text: "Hello" },
        { start: 1.5, end: 4.8, text: "World" },
      ],
    });

    expect(parsed.segments[0]).toEqual({ start: 0, end: 1.5, text: "Hello" });
    expect(parsed.segments[1]).toEqual({ start: 1.5, end: 4.8, text: "World" });
  });

  it("parses string seconds with 's' suffix", () => {
    const parsed = GeminiTranscript.parse({
      segments: [
        { start: "0s", end: "2.5s", text: "Starting" },
        { start: "2.5s", end: "10s", text: "Continuing" },
      ],
    });

    expect(parsed.segments[0].start).toBe(0);
    expect(parsed.segments[0].end).toBe(2.5);
    expect(parsed.segments[1].start).toBe(2.5);
    expect(parsed.segments[1].end).toBe(10);
  });

  it("parses MM:SS time strings", () => {
    const parsed = GeminiTranscript.parse({
      segments: [
        { start: "00:00", end: "01:30", text: "First minute and a half" },
        { start: "01:30.5", end: "02:15.25", text: "Next segment" },
      ],
    });

    expect(parsed.segments[0].start).toBe(0);
    expect(parsed.segments[0].end).toBe(90);
    expect(parsed.segments[1].start).toBe(90.5);
    expect(parsed.segments[1].end).toBe(135.25);
  });

  it("parses HH:MM:SS time strings", () => {
    const parsed = GeminiTranscript.parse({
      segments: [
        { start: "01:00:00", end: "01:02:30", text: "After one hour" },
      ],
    });

    expect(parsed.segments[0].start).toBe(3600);
    expect(parsed.segments[0].end).toBe(3750);
  });

  it("tolerates whitespace around timestamp strings", () => {
    const parsed = GeminiTranscript.parse({
      segments: [
        { start: "  00:45  ", end: "  01:15s  ", text: "Trimming spaces" },
      ],
    });

    expect(parsed.segments[0].start).toBe(45);
    expect(parsed.segments[0].end).toBe(75);
  });

  it("rejects negative timestamps", () => {
    expect(() =>
      GeminiTranscript.parse({
        segments: [{ start: -1, end: 5, text: "negative number" }],
      }),
    ).toThrow();

    expect(() =>
      GeminiTranscript.parse({
        segments: [{ start: "-5s", end: "10s", text: "negative string" }],
      }),
    ).toThrow();
  });

  it("rejects non-numeric and invalid time strings", () => {
    const invalidValues = ["invalid", "one:two", "1:2:3:4", "abc:def"];
    for (const val of invalidValues) {
      expect(() =>
        GeminiTranscript.parse({
          segments: [{ start: val, end: 10, text: "invalid start" }],
        }),
      ).toThrow();
    }
  });

  it("rejects missing required segment fields", () => {
    expect(() =>
      GeminiTranscript.parse({
        segments: [{ start: 0, end: 5 }],
      }),
    ).toThrow();

    expect(() =>
      GeminiTranscript.parse({
        segments: [{ text: "missing times" }],
      }),
    ).toThrow();
  });
});
