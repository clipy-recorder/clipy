import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

/**
 * Executable stand-ins for ffmpeg and ffprobe. The runner is faked in these
 * tests, so only the files' existence matters, and the tests pass on any OS
 * whether or not ffmpeg is installed (Homebrew puts it in /opt/homebrew/bin).
 *
 * On Windows the stubs are batch files (.bat) so they are executable on PATH.
 */
const dir = mkdtempSync(join(tmpdir(), "clipy-capture-test-"));
function stub(name: string): string {
  const isWindows = platform === "win32";
  const filename = isWindows ? `${name}.bat` : name;
  const path = join(dir, filename);
  writeFileSync(path, isWindows ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWindows) chmodSync(path, 0o755);
  return path;
}

export const FAKE_FFMPEG = stub("ffmpeg");
export const FAKE_FFPROBE = stub("ffprobe");
