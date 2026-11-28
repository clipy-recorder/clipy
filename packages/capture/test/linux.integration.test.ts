/**
 * Real recordings on a private Xvfb display. Runs only on Linux with Xvfb and
 * an ffmpeg that has x11grab and libx264; skipped elsewhere.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "../src/ffmpegArgs.js";
import { checkCapture, listSources, startCapture, startVirtualDisplay } from "../src/index.js";
import { findExecutable } from "../src/proc.js";

function canRun(): boolean {
  if (process.platform !== "linux" || !findExecutable("Xvfb", "linux") || !findExecutable("ffmpeg", "linux")) return false;
  const devices = spawnSync("ffmpeg", ["-hide_banner", "-devices"], { encoding: "utf8" });
  const encoders = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return /x11grab/.test(devices.stdout + devices.stderr) && /libx264/.test(encoders.stdout);
}

function ffprobe(path: string): { codec: string; pixFmt: string; width: number; height: number; duration: number } {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt,width,height:format=duration", "-of", "json", path],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  const data = JSON.parse(r.stdout);
  const s = data.streams[0];
  return { codec: s.codec_name, pixFmt: s.pix_fmt, width: s.width, height: s.height, duration: Number(data.format.duration) };
}

/** Decode every frame: proves the file is playable, not just parseable. */
function decodes(path: string): boolean {
  return spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", path, "-f", "null", "-"], { encoding: "utf8" }).status === 0;
}

/** Moves the pointer and clicks on the display, through XTest (libXtst). */
const DRIVER = String.raw`
import ctypes, ctypes.util, time
x = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
t = ctypes.cdll.LoadLibrary(ctypes.util.find_library("Xtst") or "libXtst.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XFlush.argtypes = [ctypes.c_void_p]
t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
d = x.XOpenDisplay(None)
for i in range(10):
    t.XTestFakeMotionEvent(d, -1, 100 + i * 40, 200 + i * 10, 0); x.XFlush(d); time.sleep(0.08)
t.XTestFakeButtonEvent(d, 1, 1, 0); x.XFlush(d); time.sleep(0.3)
t.XTestFakeButtonEvent(d, 1, 0, 0); x.XFlush(d); time.sleep(0.2)
t.XTestFakeMotionEvent(d, -1, 900, 500, 0); x.XFlush(d)
`;

function hasXtst(): boolean {
  return spawnSync("python3", ["-c", 'import ctypes.util,sys; sys.exit(0 if ctypes.util.find_library("Xtst") else 1)']).status === 0;
}

const enabled = canRun();

describe.skipIf(!enabled)("Linux capture on a virtual display", () => {
  let display: Awaited<ReturnType<typeof startVirtualDisplay>>;
  let dir: string;

  beforeAll(async () => {
    display = await startVirtualDisplay({ width: 1280, height: 720 });
    dir = mkdtempSync(join(tmpdir(), "clipy-capture-"));
  });

  afterAll(async () => {
    await display?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lists the virtual display", async () => {
    const sources = await listSources("linux", { xDisplay: display.display });
    expect(sources[0]).toMatchObject({ id: "display:0", kind: "display", width: 1280, height: 720 });
  });

  it("checks out once DISPLAY points at it", async () => {
    const before = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY };
    Object.assign(process.env, display.env({}));
    try {
      const check = await checkCapture("linux");
      expect(check.problems).toEqual([]);
      expect(check.ok).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("records 3 s into a playable H.264 MP4 with pointer moves and a click", async () => {
    const out = join(dir, "take.mp4");
    const session = await startCapture({ outPath: out, xDisplay: display.display, fps: 30 });
    expect(Math.abs(Date.now() - session.startedAt)).toBeLessThan(5000);

    let driver: ReturnType<typeof spawn> | null = null;
    if (hasXtst()) {
      await new Promise((r) => setTimeout(r, 500));
      driver = spawn("python3", ["-c", DRIVER], { env: display.env(), stdio: "ignore" });
    }
    await new Promise((r) => setTimeout(r, Math.max(0, 3000 - (Date.now() - session.startedAt))));
    const result = await session.stop();
    driver?.kill();

    expect(result.path).toBe(out);
    expect(statSync(out).size).toBeGreaterThan(1000);
    const info = ffprobe(out);
    expect(info.codec).toBe("h264");
    expect(info.pixFmt).toBe("yuv420p");
    expect([info.width, info.height]).toEqual([1280, 720]);
    expect(info.duration).toBeGreaterThan(2.5);
    expect(info.duration).toBeLessThan(4);
    expect(result.durationMs).toBeGreaterThan(2500);
    expect(result.durationMs).toBeLessThan(4000);
    expect(decodes(out)).toBe(true);

    expect(result.geometry).toEqual({ x: 0, y: 0, width: 1280, height: 720, output_width: 1280, output_height: 720 });
    expect(result.warnings).toEqual([]);

    // The pointer helper always sees the starting position.
    expect(result.interactions[0]).toMatchObject({ kind: "move", time_ms: 0 });
    for (const e of result.interactions) {
      expect(e.time_ms).toBeGreaterThanOrEqual(0);
      expect(e.time_ms).toBeLessThanOrEqual(result.durationMs);
    }
    if (driver) {
      const moves = result.interactions.filter((e) => e.kind === "move");
      expect(moves.length).toBeGreaterThanOrEqual(5);
      // No two consecutive moves at the same spot.
      for (let i = 1; i < moves.length; i++) expect([moves[i].x, moves[i].y]).not.toEqual([moves[i - 1].x, moves[i - 1].y]);
      const down = result.interactions.find((e) => e.kind === "down");
      const up = result.interactions.find((e) => e.kind === "up");
      expect(down).toMatchObject({ button: 1, x: 460, y: 290 });
      expect(up).toMatchObject({ button: 1 });
      expect(up!.time_ms - down!.time_ms).toBeGreaterThanOrEqual(200);
      expect(result.interactions.at(-1)).toMatchObject({ kind: "move", x: 900, y: 500 });
    }
  });

  it("stops by itself at maxSeconds", async () => {
    const out = join(dir, "limited.mp4");
    const session = await startCapture({ outPath: out, xDisplay: display.display, maxSeconds: 2 });
    await Promise.race([session.ended, new Promise((_, reject) => setTimeout(() => reject(new Error("did not stop")), 10_000))]);
    const result = await session.stop();
    expect(result.warnings).toEqual([]);
    expect(result.durationMs).toBeGreaterThan(1500);
    expect(result.durationMs).toBeLessThan(2600);
    expect(decodes(out)).toBe(true);
  });

  it("leaves a playable file when ffmpeg is killed outright", async () => {
    const out = join(dir, "crash.mp4");
    const args = buildFfmpegArgs({ video: { backend: "x11grab", xDisplay: display.display }, fps: 30, encoder: "libx264", output: out });
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "ignore"], env: display.env() });
    await new Promise((r) => setTimeout(r, 3500));
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    const info = ffprobe(out);
    expect(info.codec).toBe("h264");
    expect(info.duration).toBeGreaterThan(1);
    expect(decodes(out)).toBe(true);
  });

  it("aborts without leaving a file", async () => {
    const out = join(dir, "aborted.mp4");
    const session = await startCapture({ outPath: out, xDisplay: display.display });
    await new Promise((r) => setTimeout(r, 500));
    // Twice at once, then again: one abort, no error.
    await Promise.all([session.abort(), session.abort()]);
    await session.abort();
    expect(() => statSync(out)).toThrow();
    await expect(session.stop()).rejects.toThrow(/aborted/);
  });

  it("returns the same result from a second stop, and abort after stop keeps the file", async () => {
    const out = join(dir, "twice.mp4");
    const session = await startCapture({ outPath: out, xDisplay: display.display });
    await new Promise((r) => setTimeout(r, 1500));
    const [a, b] = await Promise.all([session.stop(), session.stop()]);
    expect(b).toBe(a);
    await session.abort();
    expect(statSync(out).size).toBeGreaterThan(0);
    expect(await session.stop()).toBe(a);
  });

  it("refuses a display that does not exist", async () => {
    await expect(startCapture({ outPath: join(dir, "nope.mp4"), xDisplay: display.display, source: "display:3" })).rejects.toThrow(/does not exist/);
  });
});

/** Process ids in /proc that are still running (a zombie has exited). */
function running(pids: number[]): number[] {
  return pids.filter((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    } catch {
      return false;
    }
  });
}

/** Every process whose parent is `pid`. */
function childrenOf(pid: number): number[] {
  return readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter((p) => {
      try {
        const stat = readFileSync(`/proc/${p}/stat`, "utf8");
        return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid;
      } catch {
        return false;
      }
    });
}

describe.skipIf(!enabled || process.platform !== "linux")("no orphans when the process exits without stopping", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  let dist: string;

  beforeAll(() => {
    // The child process runs the compiled package, the way an application does.
    dist = mkdtempSync(join(tmpdir(), "clipy-capture-dist-"));
    const tsc = join(here, "..", "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", join(here, "..", "tsconfig.json"), "--outDir", dist, "--declaration", "false"], { stdio: "inherit" });
    writeFileSync(join(dist, "package.json"), '{"type":"module"}');
  });

  afterAll(() => {
    if (dist) rmSync(dist, { recursive: true, force: true });
  });

  it("signals ffmpeg, the pointer helper and Xvfb, and removes the cookie", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "clipy-orphan-")), "take.mp4");
    const script = `
      import { startCapture, startVirtualDisplay } from ${JSON.stringify(join(dist, "index.js"))};
      const display = await startVirtualDisplay({ width: 640, height: 480 });
      await startCapture({ outPath: ${JSON.stringify(out)}, xDisplay: display.display });
      console.log(JSON.stringify({ pid: process.pid, xvfb: display.pid, xauthority: display.xauthority }));
      process.stdin.once("data", () => process.exit(0));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "inherit"] });
    const line = await new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout!.on("data", (c: Buffer) => {
        buf += c.toString();
        if (buf.includes("\n")) resolve(buf.split("\n")[0]);
      });
      child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
    });
    const info = JSON.parse(line) as { pid: number; xvfb: number; xauthority: string | null };
    const spawned = childrenOf(info.pid);
    // Xvfb, ffmpeg and the pointer helper.
    expect(spawned).toContain(info.xvfb);
    expect(spawned.length).toBeGreaterThanOrEqual(3);
    expect(running(spawned)).toEqual(spawned);
    if (info.xauthority) expect(existsSync(info.xauthority)).toBe(true);

    const exited = new Promise((r) => child.once("exit", r));
    child.stdin!.write("go\n");
    await exited;

    const deadline = Date.now() + 10_000;
    while (running(spawned).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(running(spawned)).toEqual([]);
    if (info.xauthority) expect(existsSync(info.xauthority)).toBe(false);
  });
});

const canTestAccessControl = process.platform === "linux" &&
  findExecutable("Xvfb", "linux") !== null &&
  findExecutable("xauth", "linux") !== null &&
  findExecutable("python3", "linux") !== null;

describe.skipIf(!canTestAccessControl)("virtual display access control", () => {
  it("starts Xvfb with a cookie and no TCP listener, and stop() can be called twice", async () => {
    const display = await startVirtualDisplay({ width: 640, height: 480 });
    try {
      const args = readFileSync(`/proc/${display.pid}/cmdline`, "utf8").split("\0");
      expect(args).toEqual(expect.arrayContaining(["-nolisten", "tcp", "-auth", display.xauthority!]));
      expect(statSync(display.xauthority!).mode & 0o077).toBe(0);
      expect(statSync(dirname(display.xauthority!)).mode & 0o077).toBe(0);
      // With the cookie, a client connects.
      const withCookie = spawnSync("python3", ["-c", OPEN_DISPLAY], { env: display.env({ PATH: process.env.PATH }) });
      expect(withCookie.status).toBe(0);
      // The localuser grant must survive after the short-lived clients exit.
      const sameUser = spawnSync("python3", ["-c", OPEN_DISPLAY], { env: { PATH: process.env.PATH, DISPLAY: display.display } });
      expect(sameUser.status).toBe(0);
      expect(display.warnings).toEqual([]);
      // With a wrong cookie and as another user (no localuser grant applies), it is refused.
      const bad = join(mkdtempSync(join(tmpdir(), "clipy-badauth-")), "Xauthority");
      execFileSync("xauth", ["-q", "-f", bad, "add", display.display, "MIT-MAGIC-COOKIE-1", "0".repeat(32)]);
      if (process.getuid?.() === 0 && spawnSync("id", ["nobody"]).status === 0 && findExecutable("runuser", "linux")) {
        const asNobody = spawnSync("runuser", ["-u", "nobody", "--", "python3", "-c", OPEN_DISPLAY], {
          env: { PATH: process.env.PATH, DISPLAY: display.display, XAUTHORITY: bad },
        });
        expect(asNobody.status).not.toBe(0);
      }
    } finally {
      await Promise.all([display.stop(), display.stop()]);
      await display.stop();
    }
    expect(existsSync(display.xauthority!)).toBe(false);
  });
});

const OPEN_DISPLAY = String.raw`
import ctypes, ctypes.util, sys
x = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
sys.exit(0 if x.XOpenDisplay(None) else 1)
`;
