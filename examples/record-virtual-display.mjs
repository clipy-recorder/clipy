#!/usr/bin/env node
/**
 * Record a private virtual display for 5 seconds with @clipy/capture.
 *
 * Starts an Xvfb display that only this script draws on, records it with
 * startCapture, moves the pointer and clicks once so the sidecar has something
 * to report, stops, and prints the file path, duration and the number of
 * interaction events. The display is stopped on every path out, including a
 * failed start and Ctrl+C.
 *
 * Needs Linux with Xvfb and an ffmpeg that has x11grab and libx264
 * (Debian/Ubuntu: `sudo apt install ffmpeg xvfb xauth libxtst6`). The pointer
 * movement also needs python3 and libXtst; without them the recording still
 * works and reports 0 interaction events.
 *
 * From the repository root:
 *
 *   pnpm install --frozen-lockfile
 *   pnpm --filter @clipy/capture build
 *   node examples/record-virtual-display.mjs [out.mp4]
 *
 * Without an argument the recording goes to a new folder under the system
 * temp directory.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SECONDS = 5;

let capture;
try {
  capture = await import("../packages/capture/dist/index.js");
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  console.error("@clipy/capture is not built yet. Run `pnpm install --frozen-lockfile && pnpm --filter @clipy/capture build` first.");
  process.exit(1);
}
const { startCapture, startVirtualDisplay } = capture;

/** Moves the pointer across the display and clicks once, through XTest. */
const POINTER_DRIVER = String.raw`
import ctypes, ctypes.util, sys, time
x = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
t = ctypes.cdll.LoadLibrary(ctypes.util.find_library("Xtst") or "libXtst.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XFlush.argtypes = [ctypes.c_void_p]
t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x.XOpenDisplay(None)
if not d:
    sys.exit(2)
for i in range(20):
    t.XTestFakeMotionEvent(d, -1, 100 + i * 50, 150 + i * 20, 0); x.XFlush(d); time.sleep(0.1)
t.XTestFakeButtonEvent(d, 1, 1, 0); x.XFlush(d); time.sleep(0.2)
t.XTestFakeButtonEvent(d, 1, 0, 0); x.XFlush(d)
`;

function canDrivePointer() {
  const probe = 'import ctypes.util, sys; sys.exit(0 if ctypes.util.find_library("Xtst") else 1)';
  return spawnSync("python3", ["-c", probe], { stdio: "ignore" }).status === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const outPath = resolve(process.argv[2] ?? join(mkdtempSync(join(tmpdir(), "clipy-example-")), "virtual-display.mp4"));

let display = null;
let session = null;
let driver = null;

// Ctrl+C or a kill: drop the half-made recording and take the display down
// before exiting, instead of leaving Xvfb running.
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    interrupted = true;
    console.error(`\n${signal}: stopping`);
    driver?.kill();
    await session?.abort().catch(() => {});
    await display?.stop().catch(() => {});
    process.exit(130);
  });
}

try {
  display = await startVirtualDisplay({ width: 1280, height: 720 });
  console.log(`virtual display ${display.display} (Xvfb pid ${display.pid})`);
  for (const w of display.warnings) console.warn(`warning: ${w}`);

  session = await startCapture({ outPath, xDisplay: display.display, fps: 30 });
  console.log(`recording for ${SECONDS} s...`);

  if (canDrivePointer()) {
    driver = spawn("python3", ["-c", POINTER_DRIVER], { env: display.env(), stdio: "ignore" });
  } else {
    console.warn("warning: python3 with libXtst not found, so nothing moves the pointer");
  }

  // Count from when ffmpeg started recording, not from when this line runs.
  await Promise.race([session.ended, sleep(Math.max(0, SECONDS * 1000 - (Date.now() - session.startedAt)))]);
  const result = await session.stop();
  session = null;

  for (const w of result.warnings) console.warn(`warning: ${w}`);
  console.log(`file:         ${result.path}`);
  console.log(`duration:     ${(result.durationMs / 1000).toFixed(2)} s`);
  console.log(`interactions: ${result.interactions.length}`);
} catch (err) {
  if (!interrupted) {
    console.error(`recording failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
  await session?.abort().catch(() => {});
} finally {
  driver?.kill();
  await display?.stop();
}
