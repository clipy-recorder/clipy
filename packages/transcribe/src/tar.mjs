// @ts-check
// A synchronous seek-bzip decoder on a worker thread. Both adapters use fixed
// buffers, so file IO happens in chunks even though the codec consumes bytes.
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const Bunzip = createRequire(import.meta.url)("seek-bzip");
const BLOCK = 512;
const CHUNK = 64 * 1024;

/** @param {number} fd */
function compressedInput(fd) {
  const buffer = Buffer.allocUnsafe(CHUNK);
  let offset = 0;
  let length = 0;
  return {
    readByte() {
      if (offset === length) {
        length = readSync(fd, buffer, 0, buffer.length, null);
        if (!length) throw new Error("Unexpected end of bzip2 input");
        offset = 0;
      }
      return buffer[offset++];
    },
    /** @param {Buffer} dest @param {number} start @param {number} count */
    read(dest, start, count) {
      for (let i = 0; i < count; i++) dest[start + i] = this.readByte();
      return count;
    },
  };
}

/** @param {Buffer} bytes */
function tarString(bytes) {
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul < 0 ? bytes.length : nul).toString("utf8");
}

/** @typedef {{name: string, path: string, temp: string, sha256: string}} Member */

/** @param {string} archivePath @param {Member[]} members */
function extract(archivePath, members) {
  const wanted = new Map(members.map((m) => [m.name, m]));
  const found = new Set();
  let remaining = 0;
  let ended = false;
  let longName = "";
  let type = "";
  /** @type {Buffer | undefined} */
  let nameRecord;
  /** @type {{fd: number, hash: import("node:crypto").Hash, member: Member} | undefined} */
  let output;
  /** @type {string | undefined} */
  let checksum;

  // Every chunk begins on a tar block boundary. Only the actual payload
  // bytes enter the hash. The next header starts after the member's padding.
  /** @param {Buffer} chunk */
  function consume(chunk) {
    if (chunk.length % BLOCK !== 0) throw new Error("Incomplete tar block");
    let pos = 0;
    while (pos < chunk.length && !ended && !checksum) {
      if (!remaining) {
        const header = chunk.subarray(pos, pos + BLOCK);
        pos += BLOCK;
        if (header.every((b) => b === 0)) {
          ended = true;
          break;
        }
        const octal = tarString(header.subarray(124, 136)).trim();
        if (!/^[0-7]+$/.test(octal)) throw new Error("Invalid tar member size");
        remaining = parseInt(octal, 8);
        type = String.fromCharCode(header[156] || 48);
        if (type === "L" || type === "x") {
          // GNU long names and pax path records apply to the next member.
          if (remaining > 1024 * 1024) throw new Error("Oversized tar name record");
          nameRecord = Buffer.alloc(remaining);
        } else if (type !== "g") {
          const prefix = tarString(header.subarray(345, 500));
          const base = tarString(header.subarray(0, 100));
          const name = longName || (prefix ? prefix + "/" + base : base);
          longName = "";
          const member = wanted.get(name.replace(/^\.\//, ""));
          if (member && (type === "0" || type === "7")) {
            output = { member, fd: openSync(member.temp, "w"), hash: createHash("sha256") };
          }
        }
      }
      const count = Math.min(remaining, chunk.length - pos);
      const data = chunk.subarray(pos, pos + count);
      if (output && count) {
        output.hash.update(data);
        writeFileSync(output.fd, data);
      }
      if (nameRecord) data.copy(nameRecord, nameRecord.length - remaining);
      remaining -= count;
      pos += Math.ceil(count / BLOCK) * BLOCK;
      if (remaining === 0) {
        if (nameRecord) {
          if (type === "L") longName = tarString(nameRecord);
          else longName = /\d+ path=([^\n]*)\n/.exec(nameRecord.toString("utf8"))?.[1] ?? longName;
          nameRecord = undefined;
        }
        if (output) {
          closeSync(output.fd);
          const { member, hash } = output;
          output = undefined;
          if (hash.digest("hex") !== member.sha256.toLowerCase()) checksum = member.path;
          else found.add(member.name);
        }
      }
    }
  }

  const fd = openSync(archivePath, "r");
  try {
    const decoded = Buffer.allocUnsafe(CHUNK);
    let used = 0;
    Bunzip.decode(compressedInput(fd), {
      /** @param {number} byte */
      writeByte(byte) {
        decoded[used++] = byte;
        if (used === decoded.length) {
          consume(decoded);
          used = 0;
        }
      },
    });
    if (used) consume(decoded.subarray(0, used));
    if (checksum) return { checksum };
    if (remaining) throw new Error("Incomplete tar member");
    return { missing: members.filter((member) => !found.has(member.name)).map((member) => member.path) };
  } finally {
    if (output) closeSync(output.fd);
    closeSync(fd);
  }
}

if (!parentPort) throw new Error("Archive extraction requires a worker thread");
parentPort.postMessage(extract(workerData.archivePath, workerData.members));
