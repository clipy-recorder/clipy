import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, even, pickH264Encoder, videoFilter, type CapturePlan } from "../src/ffmpegArgs.js";
import { windowsPlans } from "../src/capture.js";
import { parseScreensLine, primaryFirst } from "../src/sources.js";

const base = { fps: 30, encoder: "libx264" as const, output: "/tmp/out.mp4" };

/** The value after a flag, for readable assertions. */
function after(args: string[], flag: string, from = 0): string | undefined {
  const i = args.indexOf(flag, from);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildFfmpegArgs", () => {
  it("records a whole X screen with x11grab", () => {
    const args = buildFfmpegArgs({ ...base, video: { backend: "x11grab", xDisplay: ":99" } });
    expect(args).toEqual([
      "-hide_banner", "-loglevel", "info", "-nostats", "-y",
      "-thread_queue_size", "1024", "-f", "x11grab", "-draw_mouse", "1", "-framerate", "30", "-i", ":99",
      "-map", "0:v:0",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-g", "60",
      "-flush_packets", "1", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "/tmp/out.mp4",
    ]);
  });

  it("crops one monitor of an X screen, at even sizes", () => {
    const args = buildFfmpegArgs({ ...base, video: { backend: "x11grab", xDisplay: ":0", rect: { x: 1920, y: 0, width: 1281, height: 1025 } } });
    expect(after(args, "-video_size")).toBe("1280x1024");
    expect(after(args, "-grab_x")).toBe("1920");
    expect(after(args, "-grab_y")).toBe("0");
    expect(after(args, "-i")).toBe(":0");
  });

  it("records one X window by id", () => {
    const args = buildFfmpegArgs({ ...base, video: { backend: "x11grab", xDisplay: ":0", windowId: 0x1a00003 } });
    expect(after(args, "-window_id")).toBe("0x1a00003");
    expect(args).not.toContain("-video_size");
  });

  it("adds a PulseAudio or ALSA microphone as a second input", () => {
    const pulse = buildFfmpegArgs({ ...base, video: { backend: "x11grab", xDisplay: ":0" }, audio: { backend: "pulse", device: "default" } });
    expect(pulse.join(" ")).toContain("-f pulse -i default");
    expect(pulse.join(" ")).toContain("-map 0:v:0 -map 1:a:0");
    expect(after(pulse, "-c:a")).toBe("aac");
    const alsa = buildFfmpegArgs({ ...base, video: { backend: "x11grab", xDisplay: ":0" }, audio: { backend: "alsa", device: "hw:1" } });
    expect(alsa.join(" ")).toContain("-f alsa -i hw:1");
  });

  it("records a macOS screen with avfoundation and no audio", () => {
    const args = buildFfmpegArgs({ ...base, video: { backend: "avfoundation", device: "3" } });
    expect(args.join(" ")).toContain("-f avfoundation -capture_cursor 1 -capture_mouse_clicks 1 -framerate 30 -i 3:none");
    expect(args).not.toContain("-c:a");
  });

  it("takes the macOS microphone from the same avfoundation input", () => {
    const args = buildFfmpegArgs({ ...base, video: { backend: "avfoundation", device: "3" }, audio: { backend: "avfoundation", device: "default" } });
    expect(after(args, "-i")).toBe("3:default");
    expect(args.join(" ")).toContain("-map 0:v:0 -map 0:a:0");
    expect(args.filter((a) => a === "-i")).toHaveLength(1);
  });

  it("refuses avfoundation audio with another video backend", () => {
    expect(() =>
      buildFfmpegArgs({ ...base, video: { backend: "x11grab", xDisplay: ":0" }, audio: { backend: "avfoundation", device: "0" } }),
    ).toThrow(/avfoundation/);
  });

  it("records Windows with ddagrab, downloading frames from the GPU", () => {
    const args = buildFfmpegArgs({ ...base, video: { backend: "ddagrab", outputIndex: 1 }, audio: { backend: "dshow", device: "Microphone (Realtek(R) Audio)" } });
    expect(args.join(" ")).toContain("-f lavfi -i ddagrab=output_idx=1:framerate=30:draw_mouse=1");
    expect(after(args, "-vf")).toBe("hwdownload,format=bgra,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p");
    // The dshow device name stays one argv element, spaces and all.
    expect(args).toContain("audio=Microphone (Realtek(R) Audio)");
    expect(args.join(" ")).toContain("-map 0:v:0 -map 1:a:0");
  });

  it("falls back to gdigrab, cropped to a display when its bounds are known", () => {
    const whole = buildFfmpegArgs({ ...base, video: { backend: "gdigrab" } });
    expect(whole.join(" ")).toContain("-f gdigrab -draw_mouse 1 -framerate 30 -i desktop");
    const cropped = buildFfmpegArgs({ ...base, video: { backend: "gdigrab", rect: { x: -1920, y: 0, width: 1920, height: 1080 } } });
    expect(after(cropped, "-offset_x")).toBe("-1920");
    expect(after(cropped, "-video_size")).toBe("1920x1080");
    expect(after(cropped, "-vf")).toBe(videoFilter("gdigrab"));
  });

  it("stops by itself after maxSeconds and keeps the keyframe interval at 2 s", () => {
    const plan: CapturePlan = { ...base, fps: 15, maxSeconds: 90, video: { backend: "x11grab", xDisplay: ":0" } };
    const args = buildFfmpegArgs(plan);
    expect(after(args, "-t")).toBe("90");
    expect(after(args, "-g")).toBe("30");
    expect(after(args, "-framerate")).toBe("15");
  });

  it("uses the platform hardware encoder when there is no libx264", () => {
    const mac = buildFfmpegArgs({ ...base, encoder: "h264_videotoolbox", video: { backend: "avfoundation", device: "1" } });
    expect(after(mac, "-c:v")).toBe("h264_videotoolbox");
    const win = buildFfmpegArgs({ ...base, encoder: "h264_mf", video: { backend: "gdigrab" } });
    expect(after(win, "-c:v")).toBe("h264_mf");
    expect(after(win, "-pix_fmt")).toBe("yuv420p");
  });

  it("always writes a fragmented MP4 to the output path last", () => {
    const args = buildFfmpegArgs({ ...base, video: { backend: "ddagrab", outputIndex: 0 } });
    expect(args.slice(-7)).toEqual(["-flush_packets", "1", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "/tmp/out.mp4"]);
  });
});

describe("pickH264Encoder", () => {
  const encoders = [
    "Encoders:",
    " V..... = Video",
    " ------",
    " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)",
    " V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)",
  ].join("\n");

  it("prefers libx264", () => {
    expect(pickH264Encoder(encoders, "darwin")).toBe("libx264");
  });

  it("falls back to the OS encoder only on its own OS", () => {
    const noX264 = encoders.replace(/^.*libx264.*$/m, "");
    expect(pickH264Encoder(noX264, "darwin")).toBe("h264_videotoolbox");
    expect(pickH264Encoder(noX264, "linux")).toBeNull();
    expect(pickH264Encoder(" V....D h264_mf              H264 via MediaFoundation (codec h264)", "win32")).toBe("h264_mf");
  });
});

describe("even", () => {
  it("rounds down to an even size of at least 2", () => {
    expect(even(1281)).toBe(1280);
    expect(even(1)).toBe(2);
    expect(even(720)).toBe(720);
  });
});

describe("windowsPlans", () => {
  // Windows does not promise the main display is enumerated first, and
  // display:N counts the main one first, so the two orders differ: here the
  // main display is DISPLAY1, which Windows enumerated second.
  const screens = primaryFirst(
    parseScreensLine(
      'S [{"name":"DISPLAY2","x":-1920,"y":0,"width":1920,"height":1080,"primary":false},' +
        '{"name":"DISPLAY1","x":0,"y":0,"width":2560,"height":1440,"primary":true}]',
    ),
  );

  it("gives ddagrab the DXGI output number, not the display:N position", () => {
    const [ddagrab] = windowsPlans(base, screens, 0);
    expect(ddagrab.label).toBe("ddagrab");
    // display:0 is the main display, DISPLAY1, which is DXGI output 1.
    expect(buildFfmpegArgs(ddagrab.plan).join(" ")).toContain("ddagrab=output_idx=1:");

    const [second] = windowsPlans(base, screens, 1);
    expect(buildFfmpegArgs(second.plan).join(" ")).toContain("ddagrab=output_idx=0:");
  });

  it("gives the gdigrab fallback the same screen's rectangle", () => {
    const [, gdigrab] = windowsPlans(base, screens, 0);
    expect(gdigrab.label).toBe("gdigrab");
    const args = buildFfmpegArgs(gdigrab.plan);
    expect(after(args, "-offset_x")).toBe("0");
    expect(after(args, "-video_size")).toBe("2560x1440");
  });

  it("falls back to the position when the screens were never enumerated", () => {
    const [ddagrab, gdigrab] = windowsPlans(base, [], 2);
    expect(buildFfmpegArgs(ddagrab.plan).join(" ")).toContain("ddagrab=output_idx=2:");
    // No screen, so gdigrab records the whole virtual desktop.
    expect(buildFfmpegArgs(gdigrab.plan)).not.toContain("-offset_x");
  });
});
