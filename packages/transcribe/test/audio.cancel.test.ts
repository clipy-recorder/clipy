import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { extractAudio } from "../src/audio.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

it("waits for FFmpeg to close before reporting cancellation", async () => {
  const ffmpeg = Object.assign(new EventEmitter(), {
    kill: vi.fn(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(ffmpeg as unknown as ChildProcess);

  const controller = new AbortController();
  const settled = vi.fn();
  const extraction = extractAudio("input.mp4", "output.wav", controller.signal).then(settled, settled);

  controller.abort();
  ffmpeg.emit("exit", null, "SIGKILL");
  await setImmediate();
  const settledBeforeClose = settled.mock.calls.length;

  ffmpeg.stderr.end();
  ffmpeg.emit("close", null, "SIGKILL");
  await extraction;

  expect(ffmpeg.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(settledBeforeClose).toBe(0);
  expect(settled).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "AbortError", message: "Transcription was cancelled" }),
  );
});
