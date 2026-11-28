import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runningChildren, stopAllChildren, trackChild } from "../src/children.js";

const spawned: ChildProcess[] = [];

function idleChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e3)"], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
}

afterEach(async () => {
  stopAllChildren();
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited(child);
  }
  vi.restoreAllMocks();
});

describe("child process tracking", () => {
  it("sends a tracked child its registered signal on stopAllChildren", async () => {
    const child = trackChild(idleChild(), "SIGINT");
    const kill = vi.spyOn(child, "kill");
    expect(runningChildren()).toBe(1);

    stopAllChildren();
    // Windows has no SIGINT; Node ends the child either way, so check what was sent.
    expect(kill).toHaveBeenCalledWith("SIGINT");
    await exited(child);
    expect(runningChildren()).toBe(0);
  });

  it("does not track a child that has already exited", async () => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await exited(child);
    const kill = vi.spyOn(child, "kill");

    trackChild(child);
    expect(runningChildren()).toBe(0);
    stopAllChildren();
    expect(kill).not.toHaveBeenCalled();
  });

  it("counts a tracked child as running until it exits", async () => {
    const child = trackChild(idleChild());
    expect(runningChildren()).toBe(1);
    child.kill();
    await exited(child);
    expect(runningChildren()).toBe(0);
  });
});

describe("atExit", () => {
  it("runs a registered cleanup at exit, unless the returned function cancelled it", async () => {
    // A fresh copy of the module, so its exit hook can be captured instead of installed.
    vi.resetModules();
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    const { atExit } = await import("../src/children.js");
    const kept = vi.fn();
    const cancelled = vi.fn();
    atExit(kept);
    const cancel = atExit(cancelled);
    cancel();

    const exitHook = on.mock.calls.find(([event]) => event === "exit")?.[1] as () => void;
    expect(exitHook).toBeTypeOf("function");
    exitHook();
    expect(kept).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });
});
