import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { detectSilences, extractAudio, readWavInfo } from "../src/audio.js";
import { tempDir } from "./helpers.js";

// Transcript times are read off the extracted WAV, which stores no timestamps,
// so every sample has to sit where it is heard in the source file.

const dir = tempDir();
const CONTAINERS = ["mp4", "mkv"] as const;

function ff(args: string[]) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

const picture = ["-f", "lavfi", "-i", "color=c=black:s=64x64:d=12"];
const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"];

beforeAll(() => {
  for (const ext of CONTAINERS) {
    // The audio track starts 5 s after the picture and lasts 2 s.
    ff([...picture, "-itsoffset", "5", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-map", "0:v", "-map", "1:a", ...encode, join(dir, `late.${ext}`)]);
    // Tones at 1-2 s and 8-9 s, with no audio packets in between.
    ff([...picture, "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-af", "aselect='between(t,1,2)+between(t,8,9)'", ...encode, join(dir, `gap.${ext}`)]);
  }
});

async function extract(name: string) {
  const wav = join(dir, `${name}.wav`);
  await extractAudio(join(dir, name), wav);
  const info = await readWavInfo(wav);
  return { info, silences: await detectSilences(wav, undefined, info.durationSec) };
}

describe.each(CONTAINERS)("extractAudio keeps the %s timeline", (ext) => {
  it("pads the start when the audio track begins late", async () => {
    const { info, silences } = await extract(`late.${ext}`);
    expect(info.durationSec).toBeCloseTo(7, 0);
    expect(silences[0].startSec).toBeCloseTo(0, 1);
    expect(silences[0].endSec).toBeCloseTo(5, 1);
  });

  it("keeps a hole in the audio as silence", async () => {
    const { info, silences } = await extract(`gap.${ext}`);
    expect(info.durationSec).toBeCloseTo(9, 0);
    expect(silences).toHaveLength(2);
    // The second tone is still heard at 8 s, not right after the first.
    expect(silences[1].startSec).toBeCloseTo(2, 1);
    expect(silences[1].endSec).toBeCloseTo(8, 1);
  });
});

describe("extractAudio with timestamps that restart", () => {
  it("keeps all the audio of two joined recordings", async () => {
    const part = join(dir, "part.webm");
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:a", "libopus", "-f", "webm", "-live", "1", part]);
    // Byte-joined: the second half's timestamps start again at zero.
    const bytes = readFileSync(part);
    writeFileSync(join(dir, "joined.webm"), Buffer.concat([bytes, bytes]));
    const { info, silences } = await extract("joined.webm");
    expect(info.durationSec).toBeCloseTo(8, 0);
    expect(silences).toEqual([]);
  });
});
