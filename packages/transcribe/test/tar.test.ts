import { describe, expect, it } from "vitest";
import { readTar } from "../src/tar.js";

/** Helper to construct a synthetic tar archive in memory. */
function createTarArchive(
  entries: Array<{
    name: string;
    data: Buffer | string;
    type?: string;
    prefix?: string;
  }>,
): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const header = Buffer.alloc(512, 0);

    // Name (0..100)
    header.write(entry.name.slice(0, 100), 0, 100, "utf8");

    // Mode (100..108)
    header.write("0000644\0", 100, 8, "ascii");

    // UID / GID (108..124)
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");

    // Size (124..136) in octal
    const octalSize = dataBuf.length.toString(8).padStart(11, "0") + " ";
    header.write(octalSize, 124, 12, "ascii");

    // Mtime (136..148)
    header.write("00000000000\0", 136, 12, "ascii");

    // Typeflag (156)
    const type = entry.type || "0";
    header.write(type, 156, 1, "ascii");

    // Magic (257..263) & Version (263..265)
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");

    // Prefix (345..500)
    if (entry.prefix) {
      header.write(entry.prefix.slice(0, 155), 345, 155, "utf8");
    }

    // Checksum (148..156)
    header.fill(32, 148, 156); // fill with 8 spaces
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += header[i];
    const octalChksum = chksum.toString(8).padStart(6, "0") + "\0 ";
    header.write(octalChksum, 148, 8, "ascii");

    chunks.push(header);

    // Data padded to 512-byte boundary
    if (dataBuf.length > 0) {
      chunks.push(dataBuf);
      const padLen = (512 - (dataBuf.length % 512)) % 512;
      if (padLen > 0) {
        chunks.push(Buffer.alloc(padLen, 0));
      }
    }
  }

  // End-of-archive: two 512-byte blocks of zeros
  chunks.push(Buffer.alloc(1024, 0));

  return Buffer.concat(chunks);
}

describe("readTar", () => {
  it("reads standard regular files from a ustar archive", () => {
    const tar = createTarArchive([
      { name: "test1.txt", data: "Hello, World!" },
      { name: "sub/test2.json", data: JSON.stringify({ a: 1 }) },
    ]);

    const entries = [...readTar(tar)];
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe("test1.txt");
    expect(entries[0].data.toString("utf8")).toBe("Hello, World!");
    expect(entries[1].name).toBe("sub/test2.json");
    expect(entries[1].data.toString("utf8")).toBe(JSON.stringify({ a: 1 }));
  });

  it("handles path prefix fields in ustar headers", () => {
    const tar = createTarArchive([
      { name: "file.txt", prefix: "path/to/nested/dir", data: "nested content" },
    ]);

    const entries = [...readTar(tar)];
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("path/to/nested/dir/file.txt");
    expect(entries[0].data.toString("utf8")).toBe("nested content");
  });

  it("handles GNU long name extensions (type 'L')", () => {
    const longName = "very/long/nested/path/that/exceeds/the/standard/one/hundred/character/limit/in/tar/headers/file.model";
    const tar = createTarArchive([
      { name: "././@LongLink", data: longName + "\0", type: "L" },
      { name: "short_fallback.model", data: "model-weights-bytes" },
    ]);

    const entries = [...readTar(tar)];
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(longName);
    expect(entries[0].data.toString("utf8")).toBe("model-weights-bytes");
  });

  it("handles PAX extended headers (type 'x')", () => {
    const paxPath = "pax/extended/path/model.onnx";
    const paxPayload = `34 path=${paxPath}\n`;
    const tar = createTarArchive([
      { name: "PaxHeader", data: paxPayload, type: "x" },
      { name: "original.onnx", data: "onnx-model-binary" },
    ]);

    const entries = [...readTar(tar)];
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(paxPath);
    expect(entries[0].data.toString("utf8")).toBe("onnx-model-binary");
  });

  it("strips leading './' prefixes from entry names", () => {
    const tar = createTarArchive([
      { name: "./tokens.txt", data: "token1\ntoken2" },
    ]);

    const entries = [...readTar(tar)];
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("tokens.txt");
  });

  it("handles empty archive and zero-block termination cleanly", () => {
    const emptyTar = Buffer.alloc(1024, 0);
    const entries = [...readTar(emptyTar)];
    expect(entries).toEqual([]);
  });

  it("returns early on truncated or undersized buffer", () => {
    const truncated = Buffer.alloc(256, 0);
    const entries = [...readTar(truncated)];
    expect(entries).toEqual([]);
  });
});
