import { platform } from "node:process";
import { describe, expect, it } from "vitest";
import { checkCapture, hasDevice, hasFilter } from "../src/check.js";
import { looksLikeMacPermissionError, parseProbeJson } from "../src/capture.js";
import type { Runner } from "../src/proc.js";
import { FAKE_FFMPEG, FAKE_FFPROBE } from "./fakeTools.js";

/**
 * On non-Linux/non-macOS/non-Windows hosts (e.g. running macOS tests on
 * Windows CI), the FAKE_FFMPEG path uses the host OS path format while
 * findExecutable is asked to interpret it for a different platform. Skip
 * those tests gracefully with a clear message instead of failing cryptically.
 */
function skipUnlessPlatform(target: string): boolean {
  return platform !== target;
}

const DEVICES = `Devices:
 D. = Demuxing supported
 .E = Muxing supported
 ---
 DE alsa            ALSA audio output
 DE fbdev           Linux framebuffer
 D  lavfi           Libavfilter virtual input device
 DE pulse           Pulse audio output
 D  x11grab         X11 screen capture, using XCB
`;
const ENCODERS = " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)\n";

function runner(map: Record<string, string>): Runner {
  return async (_cmd, args) => {
    const flag = args.find((a) => a.startsWith("-") && a !== "-hide_banner") ?? "";
    return { status: 0, stdout: map[flag] ?? "", stderr: "" };
  };
}

describe("ffmpeg feature detection", () => {
  it("finds input devices and filters", () => {
    expect(hasDevice(DEVICES, "x11grab")).toBe(true);
    expect(hasDevice(DEVICES, "pulse")).toBe(true);
    expect(hasDevice(DEVICES, "gdigrab")).toBe(false);
    expect(hasFilter(" ... ddagrab           |->V       Grab Windows Desktop images using Desktop Duplication API\n", "ddagrab")).toBe(true);
    expect(hasFilter(" ... gfxcapture        |->V       Capture\n", "ddagrab")).toBe(false);
  });
});

describe("checkCapture", () => {
  const ffmpegEnv = { PATH: process.env.PATH, CLIPY_FFMPEG: FAKE_FFMPEG, CLIPY_FFPROBE: FAKE_FFPROBE };

  it("reports a missing ffmpeg with install steps", async () => {
    const result = await checkCapture("linux", { env: { PATH: "/nonexistent" }, run: runner({}) });
    expect(result.ok).toBe(false);
    expect(result.ffmpeg).toBeNull();
    expect(result.hints.join(" ")).toMatch(/apt install ffmpeg/);
    expect(result.hints.join(" ")).toMatch(/CLIPY_FFMPEG/);
  });

  it("passes on Linux with an X display, x11grab and libx264", async () => {
    const result = await checkCapture("linux", { env: { ...ffmpegEnv, DISPLAY: ":0" }, run: runner({ "-devices": DEVICES, "-encoders": ENCODERS }) });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.ffmpeg).toBe(FAKE_FFMPEG);
  });

  it("names a Wayland session without XWayland as the problem", async () => {
    const result = await checkCapture("linux", {
      env: { ...ffmpegEnv, XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
      run: runner({ "-devices": DEVICES, "-encoders": ENCODERS }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/Wayland session without XWayland/);
  });

  it("flags an ffmpeg without x11grab or H.264", async () => {
    const result = await checkCapture("linux", { env: { ...ffmpegEnv, DISPLAY: ":0" }, run: runner({ "-devices": " DE alsa  ALSA\n", "-encoders": "" }) });
    expect(result.problems).toHaveLength(2);
  });

  it("on macOS, fails when no screen is listed and always gives the permission hint", async () => {
    const result = await checkCapture("darwin", {
      env: ffmpegEnv,
      run: runner({ "-devices": " D  avfoundation    AVFoundation input device\n", "-encoders": ENCODERS, "-f": "" }),
    });
    expect(result.problems).toEqual(["ffmpeg lists no screens to capture"]);
    expect(result.hints.join(" ")).toMatch(/Screen Recording/);
  });

  it("on Windows, accepts gdigrab alone with a hint about ddagrab", async () => {
    const result = await checkCapture("win32", {
      env: ffmpegEnv,
      run: runner({ "-devices": " D  dshow   DirectShow capture\n D  gdigrab  GDI API Windows frame grabber\n", "-encoders": ENCODERS, "-filters": "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.hints.join(" ")).toMatch(/no ddagrab/);
  });
});

describe("capture helpers", () => {
  it("recognises the macOS permission failures", () => {
    expect(looksLikeMacPermissionError("[AVFoundation indev @ 0x1] Failed to create AV capture input device: Cannot use Capture screen 0")).toBe(true);
    expect(
      looksLikeMacPermissionError(
        "[AVFoundation indev @ 0x1] Video device not found\n[in#0 @ 0x2] Error opening input: Input/output error\nError opening input file Capture screen 0:none.",
      ),
    ).toBe(true);
    expect(looksLikeMacPermissionError("[AVFoundation indev @ 0x1] Video device not found\nError opening input file 7:none.")).toBe(false);
    expect(looksLikeMacPermissionError("Conversion failed!")).toBe(false);
  });

  it("reads ffprobe JSON", () => {
    expect(
      parseProbeJson(
        JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 1280, height: 720 }], format: { duration: "3.033333" } }),
      ),
    ).toEqual({ durationMs: 3033, width: 1280, height: 720, codec: "h264" });
    expect(parseProbeJson("not json").durationMs).toBeNull();
  });
});
