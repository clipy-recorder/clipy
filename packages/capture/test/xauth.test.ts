import { afterEach, describe, expect, it } from "vitest";
import {
  forgetXAuthority,
  registerXAuthority,
  xAuthorityFor,
  xEnv,
} from "../src/xauth";

const DISPLAYS = [":91", ":92", ":93", ":94"];

describe("xauth", () => {
  // The registry is module-level state, so clean up after every test.
  afterEach(() => {
    for (const d of DISPLAYS) forgetXAuthority(d);
  });

  describe("xAuthorityFor", () => {
    it("returns the file for a registered display", () => {
      registerXAuthority(":91", "/tmp/xauth-91");
      expect(xAuthorityFor(":91")).toBe("/tmp/xauth-91");
    });

    it("returns undefined for a display that was never registered", () => {
      expect(xAuthorityFor(":92")).toBeUndefined();
    });

    it("returns undefined for a forgotten display", () => {
      registerXAuthority(":91", "/tmp/xauth-91");
      forgetXAuthority(":91");
      expect(xAuthorityFor(":91")).toBeUndefined();
    });

    it("returns undefined when no display is given", () => {
      expect(xAuthorityFor(undefined)).toBeUndefined();
    });
  });

  describe("xEnv", () => {
    it("sets DISPLAY and XAUTHORITY for a registered display", () => {
      registerXAuthority(":91", "/tmp/xauth-91");
      const env = xEnv({ FOO: "bar" }, ":91");
      expect(env.DISPLAY).toBe(":91");
      expect(env.XAUTHORITY).toBe("/tmp/xauth-91");
      expect(env.FOO).toBe("bar");
    });

    it("overrides the caller's XAUTHORITY for a registered display", () => {
      registerXAuthority(":91", "/tmp/xauth-91");
      const env = xEnv({ XAUTHORITY: "/home/me/.Xauthority" }, ":91");
      expect(env.XAUTHORITY).toBe("/tmp/xauth-91");
    });

    it("sets DISPLAY but leaves the caller's XAUTHORITY alone for an unregistered display", () => {
      const env = xEnv({ XAUTHORITY: "/home/me/.Xauthority" }, ":92");
      expect(env.DISPLAY).toBe(":92");
      expect(env.XAUTHORITY).toBe("/home/me/.Xauthority");
    });

    it("does not add XAUTHORITY for an unregistered display when the caller has none", () => {
      const env = xEnv({}, ":93");
      expect(env.DISPLAY).toBe(":93");
      expect(env).not.toHaveProperty("XAUTHORITY");
    });

    it("never mutates the env object it is given", () => {
      registerXAuthority(":91", "/tmp/xauth-91");
      const input = { FOO: "bar" };
      const snapshot = { ...input };
      const result = xEnv(input, ":91");
      expect(input).toEqual(snapshot);
      expect(result).not.toBe(input);
    });

    it("returns the env unchanged when no display is given", () => {
      const input = { FOO: "bar" };
      expect(xEnv(input, undefined)).toBe(input);
      expect(input).toEqual({ FOO: "bar" });
    });
  });
});