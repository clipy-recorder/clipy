import { describe, expect, it } from "vitest";
import { parseSampleLine, samplesToEvents, type PointerSample } from "../src/sidecar.js";
import { encodePowerShell, LINUX_POINTER_SCRIPT, MAC_POINTER_SCRIPT, windowsPointerScript } from "../src/scripts.js";

const T0 = 1_700_000_000_000;
const s = (dt: number, x: number, y: number, buttons = 0): PointerSample => ({ t: T0 + dt, x, y, buttons });

describe("parseSampleLine", () => {
  it("reads a sample line and ignores everything else", () => {
    expect(parseSampleLine(`P ${T0} 640 -12 1`)).toEqual({ t: T0, x: 640, y: -12, buttons: 1 });
    expect(parseSampleLine(`P ${T0} 10.6 20.2 0\r`)).toEqual({ t: T0, x: 11, y: 20, buttons: 0 });
    expect(parseSampleLine('S [{"x":0}]')).toBeNull();
    expect(parseSampleLine("E cannot open X display")).toBeNull();
    expect(parseSampleLine("P garbage")).toBeNull();
  });

  it("keeps only the three tracked buttons", () => {
    expect(parseSampleLine(`P ${T0} 1 1 15`)?.buttons).toBe(7);
  });
});

describe("samplesToEvents", () => {
  it("emits a move only when the pointer moves, on the recording clock", () => {
    const events = samplesToEvents([s(0, 10, 10), s(50, 10, 10), s(100, 12, 10), s(150, 12, 10), s(200, 12, 30)], T0);
    expect(events).toEqual([
      { kind: "move", time_ms: 0, x: 10, y: 10 },
      { kind: "move", time_ms: 100, x: 12, y: 10 },
      { kind: "move", time_ms: 200, x: 12, y: 30 },
    ]);
  });

  it("places the position held before recording at time 0", () => {
    const events = samplesToEvents([s(-300, 5, 5), s(-100, 7, 7), s(40, 7, 7), s(90, 8, 7)], T0);
    expect(events).toEqual([
      { kind: "move", time_ms: 0, x: 7, y: 7 },
      { kind: "move", time_ms: 90, x: 8, y: 7 },
    ]);
  });

  it("turns button state changes into down and up with buttons 1 (left), 2 (right), 3 (middle)", () => {
    const events = samplesToEvents(
      [s(0, 100, 100), s(50, 100, 100, 1), s(100, 100, 100, 1), s(150, 104, 100, 0), s(200, 104, 100, 2), s(250, 104, 100, 6), s(300, 104, 100, 0)],
      T0,
    );
    expect(events).toEqual([
      { kind: "move", time_ms: 0, x: 100, y: 100 },
      { kind: "down", time_ms: 50, x: 100, y: 100, button: 1 },
      { kind: "move", time_ms: 150, x: 104, y: 100 },
      { kind: "up", time_ms: 150, x: 104, y: 100, button: 1 },
      { kind: "down", time_ms: 200, x: 104, y: 100, button: 2 },
      { kind: "down", time_ms: 250, x: 104, y: 100, button: 3 },
      { kind: "up", time_ms: 300, x: 104, y: 100, button: 2 },
      { kind: "up", time_ms: 300, x: 104, y: 100, button: 3 },
    ]);
  });

  it("never emits an up without its down for a button held when recording started", () => {
    const events = samplesToEvents([s(-50, 1, 1, 1), s(0, 1, 1, 1), s(50, 1, 1, 0), s(100, 1, 1, 1), s(150, 1, 1, 0)], T0);
    expect(events.filter((e) => e.kind !== "move")).toEqual([
      { kind: "down", time_ms: 100, x: 1, y: 1, button: 1 },
      { kind: "up", time_ms: 150, x: 1, y: 1, button: 1 },
    ]);
  });

  it("emits down at time 0 when button is pressed on the first sample", () => {
    const events = samplesToEvents([s(0, 50, 50, 1), s(50, 50, 50, 0)], T0);
    expect(events).toEqual([
      { kind: "move", time_ms: 0, x: 50, y: 50 },
      { kind: "down", time_ms: 0, x: 50, y: 50, button: 1 },
      { kind: "up", time_ms: 50, x: 50, y: 50, button: 1 },
    ]);
  });

  it("drops samples after the end and sorts samples that arrived out of order", () => {
    const events = samplesToEvents([s(100, 3, 3), s(0, 1, 1), s(50, 2, 2), s(2000, 9, 9)], T0, T0 + 1000);
    expect(events.map((e) => e.time_ms)).toEqual([0, 50, 100]);
  });

  it("returns nothing without samples", () => {
    expect(samplesToEvents([], T0)).toEqual([]);
  });
});

describe("helper scripts", () => {
  it("encodes PowerShell as base64 UTF-16LE", () => {
    const encoded = encodePowerShell("Write-Output 'hi'");
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Write-Output 'hi'");
  });

  it("polls at the requested interval on Windows", () => {
    expect(windowsPointerScript(50)).toContain("Start-Sleep -Milliseconds 50");
    expect(windowsPointerScript(1)).toContain("Start-Sleep -Milliseconds 10");
    expect(windowsPointerScript(50)).toContain("SetProcessDPIAware");
  });

  it("prints the shared line protocol on every OS", () => {
    for (const script of [LINUX_POINTER_SCRIPT, MAC_POINTER_SCRIPT, windowsPointerScript(50)]) {
      expect(script).toMatch(/["']P /);
      expect(script).toMatch(/["']S /);
    }
  });
});
