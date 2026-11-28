import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeServer, tempDir, type FakeServer } from "./helpers.js";

// Make the next file opened for writing fail like a full disk, either on open or on write.
const disk = vi.hoisted(() => ({ fail: null as null | "open" | "write" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      if (disk.fail === "open") throw enospc();
      const fh = await real.open(...args);
      if (disk.fail === "write") {
        fh.write = (async () => {
          throw enospc();
        }) as typeof fh.write;
      }
      return fh;
    },
  };
});

const { downloadVerified, ModelWriteError } = await import("../src/models.js");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const body = Buffer.alloc(4096, 7);
let server: FakeServer;

beforeEach(async () => {
  server = await fakeServer((_req, res) => {
    res.setHeader("content-length", body.length);
    res.end(body);
  });
});

afterEach(async () => {
  disk.fail = null;
  await server.close();
});

describe("downloadVerified when the disk fails", () => {
  it.each(["write", "open"] as const)("says the disk is full, not that the connection dropped (fails on %s)", async (where) => {
    disk.fail = where;
    const dest = join(tempDir(), "model.bin");
    const result = downloadVerified(`${server.url}/model.bin`, dest, sha(body), "Test model");
    await expect(result).rejects.toBeInstanceOf(ModelWriteError);
    await expect(result).rejects.toThrow(`Could not save Test model to ${dest}: the disk is full (ENOSPC)`);
    await expect(result).rejects.not.toThrow(/connection dropped/);
  });

  it("still downloads normally when the disk is fine", async () => {
    const dest = join(tempDir(), "model.bin");
    await expect(downloadVerified(`${server.url}/model.bin`, dest, sha(body), "Test model")).resolves.toBeUndefined();
  });
});
