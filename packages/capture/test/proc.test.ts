import { describe, expect, it } from "vitest";
import { findExecutable } from "../src/proc.js";
import { FAKE_FFMPEG } from "./fakeTools.js";

describe("findExecutable (Issue #38)", () => {
  it("recognizes path with backslashes on non-win32 target platform", () => {
    // When running on Windows host, FAKE_FFMPEG contains backslashes.
    // Even if platform is specified as darwin or linux, it should identify it as a path and find it.
    const resolvedDarwin = findExecutable(FAKE_FFMPEG, "darwin");
    expect(resolvedDarwin).toBe(FAKE_FFMPEG);

    const resolvedLinux = findExecutable(FAKE_FFMPEG, "linux");
    expect(resolvedLinux).toBe(FAKE_FFMPEG);
  });

  it("recognizes path with forward slashes on win32 target platform", () => {
    const slashPath = FAKE_FFMPEG.replace(/\\/g, "/");
    const resolvedWin32 = findExecutable(slashPath, "win32");
    expect(resolvedWin32).toBe(slashPath);
  });

  it("returns null for non-existent files", () => {
    expect(findExecutable("nonexistent_binary_xyz_123", "darwin", { PATH: "" })).toBeNull();
    expect(findExecutable("nonexistent_binary_xyz_123", "win32", { PATH: "" })).toBeNull();
  });
});
