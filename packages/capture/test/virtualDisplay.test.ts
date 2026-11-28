import { describe, expect, it } from "vitest";
import { validateDisplaySize } from "../src/virtualDisplay.js";

/** The single message every rejected size gets. */
const SIZE_MESSAGE = /virtual display size must be between 320x240 and 7680x4320/;

describe("validateDisplaySize", () => {
  it("accepts the smallest and largest sizes", () => {
    expect(validateDisplaySize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(validateDisplaySize(7680, 4320)).toEqual({ width: 7680, height: 4320 });
  });

  it("accepts an ordinary size unchanged", () => {
    expect(validateDisplaySize(1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it("rounds odd sizes down to even ones", () => {
    expect(validateDisplaySize(1001, 601)).toEqual({ width: 1000, height: 600 });
    expect(validateDisplaySize(1919, 1079)).toEqual({ width: 1918, height: 1078 });
  });

  it("rejects a width or height under the minimum", () => {
    expect(() => validateDisplaySize(319, 240)).toThrow(SIZE_MESSAGE);
    expect(() => validateDisplaySize(320, 239)).toThrow(SIZE_MESSAGE);
  });

  it("rejects a width or height over the maximum", () => {
    expect(() => validateDisplaySize(7681, 4320)).toThrow(SIZE_MESSAGE);
    expect(() => validateDisplaySize(7680, 4321)).toThrow(SIZE_MESSAGE);
  });

  it("rejects sizes that are not finite numbers", () => {
    expect(() => validateDisplaySize(Number.NaN, 240)).toThrow(SIZE_MESSAGE);
    expect(() => validateDisplaySize(320, Number.NaN)).toThrow(SIZE_MESSAGE);
    expect(() => validateDisplaySize(Number.POSITIVE_INFINITY, 240)).toThrow(SIZE_MESSAGE);
    expect(() => validateDisplaySize(320, Number.NEGATIVE_INFINITY)).toThrow(SIZE_MESSAGE);
  });

  it("names the size it refused", () => {
    expect(() => validateDisplaySize(319, 240)).toThrow("got 319x240");
    expect(() => validateDisplaySize(Number.NaN, 240)).toThrow("got NaNx240");
  });
});
