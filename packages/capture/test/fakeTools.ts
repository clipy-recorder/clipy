import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Executable stand-ins for ffmpeg and ffprobe. The runner is faked in these
 * tests, so only the files' existence matters, and the tests pass on any OS
 * whether or not ffmpeg is installed (Homebrew puts it in /opt/homebrew/bin).
 */
const dir = mkdtempSync(join(tmpdir(), "clipy-capture-test-"));
function stub(name: string): string {
  const path = join(dir, name).replace(/\\/g, "/");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

export const FAKE_FFMPEG = stub("ffmpeg");
export const FAKE_FFPROBE = stub("ffprobe");
