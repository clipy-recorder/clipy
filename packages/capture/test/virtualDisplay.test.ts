import { describe, expect, it } from "vitest";
import { validateDisplaySize } from "../src/virtualDisplay.js";

describe("validateDisplaySize", () => {
  it("accepts standard display dimensions", () => {
    expect(validateDisplaySize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(validateDisplaySize(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(validateDisplaySize(3840, 2160)).toEqual({ width: 3840, height: 2160 });
  });

  it("adjusts odd dimensions to even numbers", () => {
    // even(n) truncates/floors to even: Math.floor(n / 2) * 2
    expect(validateDisplaySize(1921, 1081)).toEqual({ width: 1920, height: 1080 });
    expect(validateDisplaySize(1281, 721)).toEqual({ width: 1280, height: 720 });
  });

  it("accepts exact minimum and maximum bounds", () => {
    expect(validateDisplaySize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(validateDisplaySize(7680, 4320)).toEqual({ width: 7680, height: 4320 });
  });

  it("rejects sizes smaller than 320x240", () => {
    expect(() => validateDisplaySize(319, 240)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(320, 239)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(100, 100)).toThrow(/between 320x240 and 7680x4320/);
  });

  it("rejects sizes larger than 7680x4320", () => {
    expect(() => validateDisplaySize(7681, 4320)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(7680, 4321)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(8000, 5000)).toThrow(/between 320x240 and 7680x4320/);
  });

  it("rejects non-finite values, NaN, and negative numbers", () => {
    expect(() => validateDisplaySize(NaN, 1080)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(1920, NaN)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(Infinity, 1080)).toThrow(/between 320x240 and 7680x4320/);
    expect(() => validateDisplaySize(-1920, 1080)).toThrow(/between 320x240 and 7680x4320/);
  });
});
