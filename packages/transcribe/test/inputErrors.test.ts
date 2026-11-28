import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractAudio, probeMedia } from "../src/audio.js";
import { transcribe } from "../src/index.js";
import { tempDir } from "./helpers.js";

// ffmpeg is replaced by canned output, so these cases give the same result on
// Windows, macOS and Linux, and need no real permission problems.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function ffmpegSays(stderr: string, code: number) {
  vi.mocked(spawn).mockImplementation((() => {
    const proc = new EventEmitter() as EventEmitter & { stderr: PassThrough; kill: () => boolean };
    proc.stderr = new PassThrough();
    proc.kill = () => true;
    proc.stderr.on("end", () => setImmediate(() => proc.emit("close", code)));
    proc.stderr.end(stderr);
    return proc;
  }) as unknown as typeof spawn);
}

const dir = tempDir();
const existing = join(dir, "exists.mp4");
writeFileSync(existing, "not really media");
const out = join(dir, "out.wav");

beforeEach(() => vi.mocked(spawn).mockReset());

describe("input errors with canned ffmpeg output", () => {
  it("reports permission denied for a file ffmpeg cannot open", async () => {
    ffmpegSays("[in#0 @ 0x1] Error opening input: Permission denied\nError opening input file x.\nError opening input files: Permission denied\n", 243);
    await expect(extractAudio(existing, out)).rejects.toThrow(`${existing} cannot be opened: permission denied`);
  });

  it("reports permission denied with kind none too", async () => {
    ffmpegSays("[in#0 @ 0x1] Error opening input: Permission denied\nError opening input files: Permission denied\n", 243);
    await expect(probeMedia(existing)).rejects.toThrow(`${existing} cannot be opened: permission denied`);
  });

  it("reports a Windows-style folder as a folder, not as permission denied", async () => {
    const folder = tempDir();
    ffmpegSays("[in#0 @ 000001] Error opening input: Permission denied\r\nError opening input files: Permission denied\r\n", 243);
    await expect(extractAudio(folder, out)).rejects.toThrow(`${folder} is a folder`);
    ffmpegSays("[in#0 @ 000001] Error opening input: Permission denied\r\nError opening input files: Permission denied\r\n", 243);
    await expect(probeMedia(folder)).rejects.toThrow(`${folder} is a folder`);
  });

  it("keeps the generic message for an unrecognised ffmpeg failure", async () => {
    ffmpegSays("[in#0 @ 0x1] Error opening input: Protocol not found\n", 187);
    await expect(extractAudio(existing, out)).rejects.toThrow(`ffmpeg could not read the audio in ${existing} (exit 187)`);
    ffmpegSays("[in#0 @ 0x1] Error opening input: Protocol not found\n", 187);
    await expect(probeMedia(existing)).rejects.toThrow(`ffmpeg could not read ${existing}`);
  });

  it("does not blame the input for a failure on the output file", async () => {
    ffmpegSays("[out#0/wav @ 0x1] Error opening output file /locked/out.wav: Permission denied\nError opening output files: Permission denied\n", 243);
    await expect(extractAudio(existing, out)).rejects.toThrow(`ffmpeg could not read the audio in ${existing} (exit 243)`);
  });

  it("does not misread a stray 'Permission denied' elsewhere in the output", async () => {
    ffmpegSays("[aac @ 0x1] cannot read side data: Permission denied\nConversion failed!\n", 1);
    await expect(extractAudio(existing, out)).rejects.toThrow(`ffmpeg could not read the audio in ${existing} (exit 1)`);
  });

  it("still reports a file with no audio as having no audio track", async () => {
    ffmpegSays("Output file #0 does not contain any stream\n", 234);
    await expect(extractAudio(existing, out)).rejects.toThrow(/has no audio track/);
  });

  it("never leaks raw ffmpeg output, even for a hosted provider", async () => {
    const secret = "SECRET-STDERR-DETAIL /home/someone/private path";
    ffmpegSays(`[in#0 @ 0x1] ${secret}\n[in#0 @ 0x1] Error opening input: Protocol not found\n`, 187);
    const err = await transcribe(existing, { kind: "openai-compatible", baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" }).catch((e: Error) => e);
    expect((err as Error).message).toBe(`ffmpeg could not read the audio in ${existing} (exit 187)`);
    expect((err as Error).message).not.toContain("SECRET");
    expect((err as Error).message).not.toContain("Protocol not found");
  });
});
