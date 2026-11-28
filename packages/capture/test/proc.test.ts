import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ffmpegPath, ffprobePath, findExecutable } from "../src/proc.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An empty folder, so no real PATH entry can answer a lookup. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clipy-proc-"));
  tempDirs.push(dir);
  return dir;
}

/** A fake executable in `dir`, or a plain file with `mode`, and its path. */
function stub(dir: string, name: string, mode = 0o755): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
  return path;
}

describe("findExecutable", () => {
  it("finds a name on PATH and returns null when it is missing", () => {
    const dir = tempDir();
    const ffmpeg = stub(dir, "ffmpeg");
    expect(findExecutable("ffmpeg", "linux", { PATH: dir })).toBe(ffmpeg);
    expect(findExecutable("ffprobe", "linux", { PATH: dir })).toBeNull();
  });

  it("searches every PATH entry, ignoring empty ones", () => {
    const empty = tempDir();
    const dir = tempDir();
    const tool = stub(dir, "tool");
    // proc.ts splits PATH with the separator of the platform running the tests.
    expect(findExecutable("tool", "linux", { PATH: [empty, dir].join(delimiter) })).toBe(tool);
    expect(findExecutable("tool", "linux", { PATH: [empty, "", dir, ""].join(delimiter) })).toBe(tool);
  });

  it("takes an explicit path, with slashes, instead of searching PATH", () => {
    const dir = tempDir();
    stub(dir, "tool");
    // Forward slashes work on every OS and are what this branch looks for.
    const explicit = join(dir, "tool").replace(/\\/g, "/");
    expect(findExecutable(explicit, "linux", { PATH: "" })).toBe(explicit);
    expect(findExecutable("/definitely/not/here/tool", "linux", { PATH: dir })).toBeNull();
  });

  it.skipIf(process.platform === "win32")("skips a file that is not executable on Linux and macOS", () => {
    // Windows has no execute bit, so this can only be checked on a POSIX host.
    for (const platform of ["linux", "darwin"] as const) {
      const dir = tempDir();
      stub(dir, "tool", 0o644);
      expect(findExecutable("tool", platform, { PATH: dir })).toBeNull();
    }
  });

  it("skips a folder that carries the program's name", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "tool"));
    expect(findExecutable("tool", "linux", { PATH: dir })).toBeNull();
  });
});

describe("findExecutable on Windows", () => {
  it("resolves .exe from PATH with the default PATHEXT", () => {
    const dir = tempDir();
    const ffmpeg = stub(dir, "ffmpeg.EXE");
    expect(findExecutable("ffmpeg", "win32", { PATH: dir })).toBe(ffmpeg);
  });

  it("honours PATHEXT and does not double an extension already there", () => {
    const withCmd = tempDir();
    const cmd = stub(withCmd, "tool.CMD");
    expect(findExecutable("tool", "win32", { PATH: withCmd, PATHEXT: ".CMD" })).toBe(cmd);

    const withExe = tempDir();
    const exe = stub(withExe, "ffmpeg.exe");
    expect(findExecutable("ffmpeg.exe", "win32", { PATH: withExe })).toBe(exe);
  });

  it("reads the Path spelling of the variable", () => {
    const dir = tempDir();
    const tool = stub(dir, "tool.EXE");
    expect(findExecutable("tool", "win32", { Path: dir })).toBe(tool);
  });
});

describe("ffmpegPath", () => {
  it("prefers CLIPY_FFMPEG over a copy on PATH", () => {
    const onPath = tempDir();
    stub(onPath, "ffmpeg");
    const chosen = stub(tempDir(), "mine-ffmpeg");
    expect(ffmpegPath("linux", { PATH: onPath, CLIPY_FFMPEG: chosen })).toBe(chosen);
  });

  it("finds a bare CLIPY_FFMPEG on PATH", () => {
    const dir = tempDir();
    const ffmpeg = stub(dir, "ffmpeg-custom");
    expect(ffmpegPath("linux", { PATH: dir, CLIPY_FFMPEG: "ffmpeg-custom" })).toBe(ffmpeg);
  });

  it("returns null for a CLIPY_FFMPEG that does not exist, rather than falling back to PATH", () => {
    const onPath = tempDir();
    stub(onPath, "ffmpeg");
    expect(ffmpegPath("linux", { PATH: onPath, CLIPY_FFMPEG: "/nope/ffmpeg" })).toBeNull();
  });

  it("falls back to ffmpeg on PATH", () => {
    const dir = tempDir();
    const ffmpeg = stub(dir, "ffmpeg");
    expect(ffmpegPath("linux", { PATH: dir })).toBe(ffmpeg);
    expect(ffmpegPath("linux", { PATH: tempDir() })).toBeNull();
  });
});

describe("ffprobePath", () => {
  it("prefers CLIPY_FFPROBE over everything else", () => {
    const onPath = tempDir();
    stub(onPath, "ffmpeg");
    stub(onPath, "ffprobe");
    const chosen = stub(tempDir(), "mine-ffprobe");
    expect(ffprobePath("linux", { PATH: onPath, CLIPY_FFPROBE: chosen })).toBe(chosen);
    expect(ffprobePath("linux", { PATH: onPath, CLIPY_FFPROBE: "/nope/ffprobe" })).toBeNull();
  });

  it("uses the ffprobe next to the ffmpeg it found, before the one on PATH", () => {
    const elsewhere = tempDir();
    const onPath = stub(elsewhere, "ffprobe");
    const dir = tempDir();
    stub(dir, "ffmpeg");
    const sibling = stub(dir, "ffprobe");
    expect(ffprobePath("linux", { PATH: [dir, elsewhere].join(delimiter) })).toBe(sibling);

    const lone = tempDir();
    stub(lone, "ffmpeg");
    expect(ffprobePath("linux", { PATH: [lone, elsewhere].join(delimiter) })).toBe(onPath);
  });

  it("falls back to ffprobe on PATH when there is no ffmpeg at all", () => {
    const dir = tempDir();
    const ffprobe = stub(dir, "ffprobe");
    expect(ffprobePath("linux", { PATH: dir })).toBe(ffprobe);
    expect(ffprobePath("linux", { PATH: tempDir() })).toBeNull();
  });
});
