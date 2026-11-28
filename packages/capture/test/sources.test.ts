import { describe, expect, it } from "vitest";
import type { Runner, RunResult } from "../src/proc.js";
import { FAKE_FFMPEG } from "./fakeTools.js";
import {
  avfoundationScreens,
  listSources,
  parseAvfoundationDevices,
  parseClientList,
  parseDshowAudioDevices,
  parseProbedScreenSize,
  parseScreensLine,
  parseSourceId,
  parseWindowGeometry,
  parseWindowProps,
  parseXdpyinfoSize,
  parseXrandrMonitors,
  primaryFirst,
} from "../src/sources.js";

const XRANDR = `Monitors: 2
 0: +eDP-1 1920/344x1080/194+0+0  eDP-1
 1: +*HDMI-1 2560/597x1440/336+1920+0  HDMI-1
`;

const AVFOUNDATION = `[AVFoundation indev @ 0x7fb8a2c04a40] AVFoundation video devices:
[AVFoundation indev @ 0x7fb8a2c04a40] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7fb8a2c04a40] [1] OBS Virtual Camera
[AVFoundation indev @ 0x7fb8a2c04a40] [2] Capture screen 0
[AVFoundation indev @ 0x7fb8a2c04a40] [3] Capture screen 1
[AVFoundation indev @ 0x7fb8a2c04a40] AVFoundation audio devices:
[AVFoundation indev @ 0x7fb8a2c04a40] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x7fb8a2c04a40] [1] ZoomAudioDevice
: Input/output error
`;

const DSHOW_NEW = `[dshow @ 0000020b8f6f5a40] "Integrated Camera" (video)
[dshow @ 0000020b8f6f5a40]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2"
[dshow @ 0000020b8f6f5a40] "Microphone Array (Realtek(R) Audio)" (audio)
[dshow @ 0000020b8f6f5a40]   Alternative name "@device_cm_{33D9A762}\\wave_{A1B2}"
[dshow @ 0000020b8f6f5a40] "Headset (Jabra Evolve2 65)" (audio)
dummy: Immediate exit requested
`;

const DSHOW_LEGACY = `[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001]  "Integrated Camera"
[dshow @ 000001]     Alternative name "@device_pnp_x"
[dshow @ 000001] DirectShow audio devices
[dshow @ 000001]  "Microphone (USB Audio)"
[dshow @ 000001]     Alternative name "@device_cm_y"
`;

describe("Linux parsers", () => {
  it("reads monitors and the primary flag from xrandr", () => {
    expect(parseXrandrMonitors(XRANDR)).toEqual([
      { name: "eDP-1", primary: false, x: 0, y: 0, width: 1920, height: 1080 },
      { name: "HDMI-1", primary: true, x: 1920, y: 0, width: 2560, height: 1440 },
    ]);
  });

  it("puts the primary monitor first, so display:0 is the main one", () => {
    expect(primaryFirst(parseXrandrMonitors(XRANDR)).map((s) => s.name)).toEqual(["HDMI-1", "eDP-1"]);
  });

  it("reads the screen size from xdpyinfo and from ffmpeg's probe", () => {
    expect(parseXdpyinfoSize("screen #0:\n  dimensions:    1280x720 pixels (339x191 millimeters)\n")).toEqual({ width: 1280, height: 720 });
    expect(parseXdpyinfoSize("nothing")).toBeNull();
    expect(
      parseProbedScreenSize("Input #0, x11grab, from ':99':\n  Stream #0:0: Video: rawvideo (BGR[0] / 0x524742), bgr0, 1280x720, 30 fps"),
    ).toEqual({ width: 1280, height: 720 });
  });

  it("reads windows from xprop and xwininfo", () => {
    expect(parseClientList("_NET_CLIENT_LIST(WINDOW): window id # 0x1a00003, 0x2200007")).toEqual([0x1a00003, 0x2200007]);
    const g = parseWindowGeometry(
      "xwininfo: Window id: 0x1a00003 \"Term\"\n  Absolute upper-left X:  10\n  Absolute upper-left Y:  -4\n  Width: 800\n  Height: 600\n  Map State: IsViewable\n",
    );
    expect(g).toEqual({ x: 10, y: -4, width: 800, height: 600, viewable: true });
    expect(parseWindowProps('_NET_WM_NAME(UTF8_STRING) = "say \\"hi\\""\nWM_CLASS(STRING) = "xterm", "XTerm"')).toEqual({ title: 'say "hi"', app: "XTerm" });
  });
});

describe("macOS parsers", () => {
  it("lists avfoundation video and audio devices", () => {
    const devices = parseAvfoundationDevices(AVFOUNDATION);
    expect(devices.video.map((d) => d.index)).toEqual([0, 1, 2, 3]);
    expect(devices.audio).toEqual([
      { index: 0, name: "MacBook Pro Microphone" },
      { index: 1, name: "ZoomAudioDevice" },
    ]);
  });

  it("keeps only the screens, in screen order, with their device index", () => {
    expect(avfoundationScreens(parseAvfoundationDevices(AVFOUNDATION))).toEqual([
      { index: 2, name: "Capture screen 0", screen: 0 },
      { index: 3, name: "Capture screen 1", screen: 1 },
    ]);
  });
});

describe("Windows parsers", () => {
  it("reads dshow audio devices in the current format, skipping alternative names", () => {
    expect(parseDshowAudioDevices(DSHOW_NEW)).toEqual(["Microphone Array (Realtek(R) Audio)", "Headset (Jabra Evolve2 65)"]);
  });

  it("reads dshow audio devices in the older sectioned format", () => {
    expect(parseDshowAudioDevices(DSHOW_LEGACY)).toEqual(["Microphone (USB Audio)"]);
  });

  it("reads the screens line, as an array or a single object", () => {
    const two = parseScreensLine(
      'noise\r\nS [{"name":"\\\\\\\\.\\\\DISPLAY2","x":-1920,"y":0,"width":1920,"height":1080,"primary":false},{"name":"\\\\\\\\.\\\\DISPLAY1","x":0,"y":0,"width":2560,"height":1440,"primary":true}]\r\n',
    );
    expect(primaryFirst(two).map((s) => [s.name, s.x])).toEqual([
      ["\\\\.\\DISPLAY1", 0],
      ["\\\\.\\DISPLAY2", -1920],
    ]);
    expect(parseScreensLine('S {"name":"","x":0,"y":0,"width":1366,"height":768,"primary":true}')).toEqual([
      { name: "Display 1", primary: true, x: 0, y: 0, width: 1366, height: 768 },
    ]);
    expect(parseScreensLine("S not json")).toEqual([]);
  });
});

describe("parseSourceId", () => {
  it("defaults to the main display", () => {
    expect(parseSourceId(undefined)).toEqual({ kind: "display", index: 0 });
    expect(parseSourceId("display:2")).toEqual({ kind: "display", index: 2 });
    expect(parseSourceId("1")).toEqual({ kind: "display", index: 1 });
  });

  it("parses display IDs case-insensitively", () => {
    expect(parseSourceId("DISPLAY:2")).toEqual({ kind: "display", index: 2 });
    expect(parseSourceId("Display:1")).toEqual({ kind: "display", index: 1 });
  });

  it("parses window IDs case-insensitively", () => {
    expect(parseSourceId("WINDOW:0x1a")).toEqual({ kind: "window", id: 26 });
    expect(parseSourceId("Window:0x1a")).toEqual({ kind: "window", id: 26 });
  });

  it("reads window ids in hex or decimal", () => {
    expect(parseSourceId("window:0x1a00003")).toEqual({ kind: "window", id: 0x1a00003 });
    expect(parseSourceId("window:27262979")).toEqual({ kind: "window", id: 27262979 });
  });

    it("rejects anything else", () => {
    expect(() => parseSourceId("screen-1")).toThrow(/unknown capture source/);
  });
});


/** A fake runner answering by command name. */
function fakeRunner(answers: Record<string, Partial<RunResult>>): Runner {
  return async (cmd, args) => {
    const key = Object.keys(answers).find((k) => cmd.endsWith(k) || `${cmd} ${args.join(" ")}`.includes(k));
    if (!key) return { status: null, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "", ...answers[key] };
  };
}

describe("listSources", () => {
  const env = { ...process.env, CLIPY_FFMPEG: FAKE_FFMPEG, PATH: process.env.PATH };

  it("lists Linux monitors, main first, and no windows without x11-utils", async () => {
    const sources = await listSources("linux", { xDisplay: ":0", env, run: fakeRunner({ xrandr: { stdout: XRANDR } }) });
    expect(sources).toEqual([
      { id: "display:0", kind: "display", name: "HDMI-1 (main)", width: 2560, height: 1440 },
      { id: "display:1", kind: "display", name: "eDP-1", width: 1920, height: 1080 },
    ]);
  });

  it("falls back to xdpyinfo for a bare X server", async () => {
    const sources = await listSources("linux", {
      xDisplay: ":99",
      env,
      run: fakeRunner({ xdpyinfo: { stdout: "  dimensions:    1024x768 pixels (271x203 millimeters)" } }),
    });
    expect(sources).toEqual([{ id: "display:0", kind: "display", name: "screen :99", width: 1024, height: 768 }]);
  });

  it("lists Linux windows when xprop and xwininfo are there", async () => {
    const sources = await listSources("linux", {
      xDisplay: ":0",
      env,
      run: fakeRunner({
        xrandr: { stdout: " 0: +*default 1280/339x720/191+0+0  default" },
        "-root _NET_CLIENT_LIST": { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x400001" },
        "xwininfo -id 0x400001": { stdout: "  Absolute upper-left X:  0\n  Absolute upper-left Y:  0\n  Width: 640\n  Height: 480\n  Map State: IsViewable" },
        "xprop -id 0x400001": { stdout: '_NET_WM_NAME(UTF8_STRING) = "notes.txt"\nWM_CLASS(STRING) = "gedit", "Gedit"' },
      }),
    });
    expect(sources[1]).toEqual({ id: "window:0x400001", kind: "window", name: "Gedit: notes.txt", width: 640, height: 480 });
  });

  it("lists macOS screens from avfoundation", async () => {
    const sources = await listSources("darwin", { env, run: fakeRunner({ ffmpeg: { status: 1, stderr: AVFOUNDATION } }) });
    expect(sources).toEqual([
      { id: "display:0", kind: "display", name: "Capture screen 0 (main)" },
      { id: "display:1", kind: "display", name: "Capture screen 1" },
    ]);
  });

  it("lists Windows screens from PowerShell, main first", async () => {
    const sources = await listSources("win32", {
      env,
      run: fakeRunner({
        "powershell.exe": {
          stdout:
            'S [{"name":"DISPLAY2","x":1920,"y":0,"width":1280,"height":1024,"primary":false},{"name":"DISPLAY1","x":0,"y":0,"width":1920,"height":1080,"primary":true}]',
        },
      }),
    });
    expect(sources.map((s) => s.name)).toEqual(["DISPLAY1 (main)", "DISPLAY2"]);
  });

  it("still offers the main display on Windows when PowerShell is missing", async () => {
    expect(await listSources("win32", { env, run: fakeRunner({}) })).toEqual([{ id: "display:0", kind: "display", name: "Display 1 (main)" }]);
  });
});
