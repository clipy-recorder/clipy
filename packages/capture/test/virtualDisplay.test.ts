import { describe, expect, it } from "vitest";
import { validateDisplaySize } from "../src/virtualDisplay.js";

describe("validateDisplaySize", () => {
  it("keeps valid even display sizes within limits", () => {
    expect(validateDisplaySize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(validateDisplaySize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(validateDisplaySize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("rounds odd dimensions down to even sizes of at least 2", () => {
    expect(validateDisplaySize(1921, 1081)).toEqual({ width: 1920, height: 1080 });
    expect(validateDisplaySize(1025, 769)).toEqual({ width: 1024, height: 768 });
  });

  it("accepts minimum boundary dimensions (320x240)", () => {
    expect(validateDisplaySize(320, 240)).toEqual({ width: 320, height: 240 });
  });

  it("accepts maximum boundary dimensions (7680x4320)", () => {
    expect(validateDisplaySize(7680, 4320)).toEqual({ width: 7680, height: 4320 });
  });

  it("throws when width is below 320", () => {
    expect(() => validateDisplaySize(319, 240)).toThrow(/between 320x240 and 7680x4320/);
  });

  it("throws when height is below 240", () => {
    expect(() => validateDisplaySize(320, 239)).toThrow(/between 320x240 and 7680x4320/);
  });

  it("throws when width exceeds 7680", () => {
    expect(() => validateDisplaySize(7681, 1080)).toThrow(/between 320x240 and 7680x4320/);
  });

  it("throws when height exceeds 4320", () => {
    expect(() => validateDisplaySize(1920, 4321)).toThrow(/between 320x240 and 7680x4320/);
  });

  it("throws for non-finite dimensions", () => {
    expect(() => validateDisplaySize(NaN, 1080)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(1920, NaN)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(Infinity, 1080)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(1920, -Infinity)).toThrow(/between 320x240 and 7680x4320/);
  });
});
