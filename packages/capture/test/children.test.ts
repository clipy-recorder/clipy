import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atExit, runningChildren, stopAllChildren, trackChild } from "../src/children.js";

interface MockChild extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killedSignals: NodeJS.Signals[];
  kill: (signal?: NodeJS.Signals) => boolean;
}

function createMockChild(options?: {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  killError?: Error;
}): MockChild {
  const emitter = new EventEmitter();
  const killedSignals: NodeJS.Signals[] = [];
  const child = Object.assign(emitter, {
    exitCode: options?.exitCode ?? null,
    signalCode: options?.signalCode ?? null,
    killedSignals,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      if (options?.killError) throw options.killError;
      killedSignals.push(signal);
      return true;
    }),
  });
  return child as unknown as MockChild;
}

describe("children tracking and lifecycle", () => {
  afterEach(() => {
    stopAllChildren();
  });

  it("tracks a running child and increments runningChildren", () => {
    const initial = runningChildren();
    const child = createMockChild();
    const result = trackChild(child as unknown as ChildProcess);

    expect(result).toBe(child);
    expect(runningChildren()).toBe(initial + 1);
  });

  it("ignores a child that has already exited with an exitCode", () => {
    const initial = runningChildren();
    const child = createMockChild({ exitCode: 0 });
    trackChild(child as unknown as ChildProcess);

    expect(runningChildren()).toBe(initial);
  });

  it("ignores a child that has already exited with a signalCode", () => {
    const initial = runningChildren();
    const child = createMockChild({ signalCode: "SIGKILL" });
    trackChild(child as unknown as ChildProcess);

    expect(runningChildren()).toBe(initial);
  });

  it("untracks a child when it emits an exit event", () => {
    const initial = runningChildren();
    const child = createMockChild();
    trackChild(child as unknown as ChildProcess);
    expect(runningChildren()).toBe(initial + 1);

    child.emit("exit", 0, null);
    expect(runningChildren()).toBe(initial);
  });

  it("untracks a child when it emits an error event", () => {
    const initial = runningChildren();
    const child = createMockChild();
    trackChild(child as unknown as ChildProcess);
    expect(runningChildren()).toBe(initial + 1);

    child.emit("error", new Error("spawn failure"));
    expect(runningChildren()).toBe(initial);
  });

  it("signals every running tracked child with its configured signal on stopAllChildren", () => {
    const child1 = createMockChild();
    const child2 = createMockChild();

    trackChild(child1 as unknown as ChildProcess, "SIGTERM");
    trackChild(child2 as unknown as ChildProcess, "SIGINT");

    stopAllChildren();

    expect(child1.killedSignals).toEqual(["SIGTERM"]);
    expect(child2.killedSignals).toEqual(["SIGINT"]);
    expect(runningChildren()).toBe(0);
  });

  it("gracefully catches errors when child.kill throws", () => {
    const child = createMockChild({ killError: new Error("process already dead") });
    trackChild(child as unknown as ChildProcess);

    expect(() => stopAllChildren()).not.toThrow();
    expect(runningChildren()).toBe(0);
  });

  it("allows registering and unregistering cleanup functions via atExit", () => {
    const cleanup = vi.fn();
    const cancel = atExit(cleanup);

    expect(typeof cancel).toBe("function");
    cancel();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
