import { describe, expect, it } from "vitest";
import { readTar, type TarEntry } from "../src/tar.js";

function padTo512(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(512 - rem)]);
}

function writeOctal(buf: Buffer, offset: number, len: number, value: number): void {
  const str = value.toString(8).padStart(len - 1, "0");
  buf.write(str.slice(-(len - 1)), offset, len - 1, "ascii");
  buf[offset + len - 1] = 0;
}

interface TarHeaderOptions {
  name: string;
  size?: number;
  type?: string | number;
  prefix?: string;
}

function tarHeader({ name, size = 0, type = "0", prefix = "" }: TarHeaderOptions): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = typeof type === "number" ? type : type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const chk = sum.toString(8).padStart(6, "0");
  header.write(chk, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function tarEntry(opts: TarHeaderOptions, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const header = tarHeader({ ...opts, size: opts.size ?? data.length });
  return data.length === 0 ? header : Buffer.concat([header, padTo512(data)]);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body, "utf8") + 1;
  while (true) {
    const line = `${len}${body}`;
    const actual = Buffer.byteLength(line, "utf8");
    if (actual === len) return Buffer.from(line, "utf8");
    len = actual;
  }
}

function collect(buf: Buffer): Array<{ name: string; text: string; data: Buffer }> {
  return Array.from(readTar(buf), (entry: TarEntry) => ({
    name: entry.name,
    text: entry.data.toString("utf8"),
    data: entry.data,
  }));
}

describe("readTar", () => {
  it("reads plain ustar files in order with non-512-byte padding", () => {
    const secondPayload = Buffer.alloc(515, 0x61);
    secondPayload[514] = 0x7a;
    const archive = Buffer.concat([
      tarEntry({ name: "hello.txt" }, "hello"),
      tarEntry({ name: "nested/big.bin" }, secondPayload),
      tarEntry({ name: "empty.txt" }),
      Buffer.alloc(1024),
    ]);

    const entries = Array.from(readTar(archive));
    expect(entries.map((e) => e.name)).toEqual(["hello.txt", "nested/big.bin", "empty.txt"]);
    expect(entries[0].data.toString("utf8")).toBe("hello");
    expect(entries[1].data.equals(secondPayload)).toBe(true);
    expect(entries[2].data.length).toBe(0);
  });

  it("strips a leading ./ from entry names", () => {
    const archive = Buffer.concat([
      tarEntry({ name: "./root.txt" }, "one"),
      tarEntry({ name: "./dir/sub.txt" }, "two"),
      Buffer.alloc(512),
    ]);

    expect(collect(archive).map((e) => [e.name, e.text])).toEqual([
      ["root.txt", "one"],
      ["dir/sub.txt", "two"],
    ]);
  });

  it("joins the ustar prefix field to the entry name", () => {
    const archive = Buffer.concat([
      tarEntry({ prefix: "models/parakeet", name: "tokens.txt" }, "tok"),
      tarEntry({ prefix: "./models/parakeet", name: "model.onnx" }, "bin"),
      Buffer.alloc(512),
    ]);

    expect(collect(archive).map((e) => [e.name, e.text])).toEqual([
      ["models/parakeet/tokens.txt", "tok"],
      ["models/parakeet/model.onnx", "bin"],
    ]);
  });

  it("reads GNU long names (type L) and resets for subsequent entries", () => {
    const longPath = `./${"segment/".repeat(16)}weights.onnx`;
    expect(longPath.length).toBeGreaterThan(100);

    const archive = Buffer.concat([
      tarEntry({ name: "././@LongLink", type: "L" }, `${longPath}\0`),
      tarEntry({ name: "truncated-placeholder" }, "model-bytes"),
      tarEntry({ name: "normal.txt" }, "after"),
      Buffer.alloc(512),
    ]);

    expect(collect(archive).map((e) => [e.name, e.text])).toEqual([
      [longPath.slice(2), "model-bytes"],
      ["normal.txt", "after"],
    ]);
  });

  it("reads pax path= records (type x) and ignores pax records without path=", () => {
    const paxPath = `models/${"deep/".repeat(20)}音声-tokens.txt`;
    expect(Buffer.byteLength(paxPath, "utf8")).toBeGreaterThan(100);

    const archive = Buffer.concat([
      tarEntry({ name: "PaxHeader/file", type: "x" }, paxRecord("path", `./${paxPath}`)),
      tarEntry({ name: "fallback-name" }, "pax-data"),
      tarEntry({ name: "PaxHeader/meta", type: "x" }, paxRecord("mtime", "1700000000")),
      tarEntry({ name: "kept-name.txt" }, "still-here"),
      Buffer.alloc(512),
    ]);

    expect(collect(archive).map((e) => [e.name, e.text])).toEqual([
      [paxPath, "pax-data"],
      ["kept-name.txt", "still-here"],
    ]);
  });

  it("skips pax global headers (type g)", () => {
    const archive = Buffer.concat([
      tarEntry({ name: "pax_global_header", type: "g" }, paxRecord("comment", "release-tag")),
      tarEntry({ name: "after-global.txt" }, "ok"),
      Buffer.alloc(512),
    ]);

    expect(collect(archive).map((e) => [e.name, e.text])).toEqual([["after-global.txt", "ok"]]);
  });

  it("skips directories (type 5) without leaking a preceding long name", () => {
    const longDir = `${"folder/".repeat(18)}sub`;
    const archive = Buffer.concat([
      tarEntry({ name: "dir/", type: "5" }),
      tarEntry({ name: "././@LongLink", type: "L" }, `${longDir}\0`),
      tarEntry({ name: "truncated-dir", type: "5" }),
      tarEntry({ name: "inside.txt" }, "file-content"),
      Buffer.alloc(512),
    ]);

    expect(collect(archive).map((e) => [e.name, e.text])).toEqual([["inside.txt", "file-content"]]);
  });

  it("stops reading at the zero block", () => {
    const archive = Buffer.concat([
      tarEntry({ name: "before.txt" }, "first"),
      Buffer.alloc(512),
      tarEntry({ name: "after-zero.txt" }, "unreachable"),
      Buffer.alloc(512),
    ]);

    expect(collect(archive).map((e) => [e.name, e.text])).toEqual([["before.txt", "first"]]);
  });

  it("supports V7 NUL and contiguous (7) file typeflags and handles empty/short buffers", () => {
    const archive = Buffer.concat([
      tarEntry({ name: "v7.txt", type: 0 }, "nul-type"),
      tarEntry({ name: "contig.txt", type: "7" }, "seven-type"),
      Buffer.alloc(512),
    ]);

    expect(collect(archive).map((e) => [e.name, e.text])).toEqual([
      ["v7.txt", "nul-type"],
      ["contig.txt", "seven-type"],
    ]);
    expect(collect(Buffer.alloc(0))).toEqual([]);
    expect(collect(Buffer.alloc(511))).toEqual([]);
  });
});
