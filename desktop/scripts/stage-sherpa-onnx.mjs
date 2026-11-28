/**
 * Stage sherpa-onnx for the local edition on Windows (Clipy Local).
 *
 * The local edition links `clipy-local-stt` with sherpa-onnx's *shared*
 * libraries (crates/clipy-local-stt/README.md, "Windows linking risk"), so
 * two DLLs must sit beside `clipy-desktop.exe` on the user's machine, like the
 * FFmpeg DLLs (scripts/stage-ffmpeg-dlls.mjs):
 *
 *     onnxruntime.dll, sherpa-onnx-c-api.dll
 *
 * `sherpa-onnx-sys`'s build script downloads its prebuilt archive from GitHub
 * without checking a checksum. This script downloads the same pinned archive
 * itself (or takes it from SHERPA_ONNX_ARCHIVE_DIR), checks its SHA-256
 * against the value pinned here and in the crate README, then:
 *
 * - removes any archive or extracted copy in the build script's own cache
 *   (`target/sherpa-onnx-prebuilt/`) that does not match, so a build can only
 *   link what was checked;
 * - extracts the two DLLs into `src-tauri/sherpa-bin/`, which
 *   `tauri.local.windows.conf.json` bundles next to the executable;
 * - returns the archive folder, which `scripts/tauri-local.mjs` passes to the
 *   build as SHERPA_ONNX_ARCHIVE_DIR.
 *
 * No-op on non-Windows hosts (macOS keeps Apple Speech) unless `--force`.
 * Run directly, it prints `SHERPA_ONNX_ARCHIVE_DIR=<folder>`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { argv, env, exit, platform } from "node:process";

/** Must equal the exact `sherpa-onnx-sys` version in crates/clipy-local-stt/Cargo.toml. */
export const SHERPA_ONNX_VERSION = "2.0.2";
export const ARCHIVE = `sherpa-onnx-v${SHERPA_ONNX_VERSION}-win-x64-shared-MT-Release-lib.tar.bz2`;
/** crates/clipy-local-stt/README.md, "Build-time download, proxies and pinning". */
export const ARCHIVE_SHA256 = "14db8ff397f56e4b102e958a2f29c3a13a2eb40643a3a4d0373b65b2b82c4bb3";
export const ARCHIVE_URL =
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_ONNX_VERSION}/${ARCHIVE}`;
/** What ships beside the exe. `onnxruntime_providers_shared.dll` is for GPU providers only. */
export const DLLS = ["onnxruntime.dll", "sherpa-onnx-c-api.dll"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAURI_DIR = path.join(HERE, "..", "src-tauri");
const STEM = ARCHIVE.replace(/\.tar\.bz2$/, "");

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function verified(file) {
  return existsSync(file) && (await sha256(file)) === ARCHIVE_SHA256;
}

async function download(dest) {
  const partial = `${dest}.partial-${process.pid}`;
  const response = await fetch(ARCHIVE_URL, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download of ${ARCHIVE} failed (HTTP ${response.status})`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if ((await sha256(partial)) !== ARCHIVE_SHA256) {
      throw new Error(`checksum mismatch for the downloaded ${ARCHIVE}; nothing was staged`);
    }
    renameSync(partial, dest);
  } finally {
    rmSync(partial, { force: true });
  }
}

/** Keep Cargo from reusing extracted files that were not checked against the archive. */
async function scrubBuildCache(targetDir) {
  const cache = path.join(targetDir, "sherpa-onnx-prebuilt");
  const cachedArchive = path.join(cache, ARCHIVE);
  const extracted = path.join(cache, STEM);
  if (existsSync(cachedArchive) && !(await verified(cachedArchive))) {
    console.warn(`[stage-sherpa-onnx] removing an unverified ${cachedArchive}`);
    rmSync(cachedArchive, { force: true });
  }
  if (existsSync(extracted)) {
    // Even a matching cached archive does not prove these files came from it.
    // Force sherpa-onnx-sys to unpack the archive that was just verified.
    console.warn(`[stage-sherpa-onnx] removing unchecked extracted cache ${extracted}`);
    rmSync(extracted, { recursive: true, force: true });
  }
}

function extractDlls(archive, destDir, targetDir) {
  const temp = mkdtempSync(path.join(targetDir, ".sherpa-extract-"));
  try {
    const members = DLLS.map((dll) => `${STEM}/lib/${dll}`);
    const result = spawnSync("tar", ["-xjf", archive, "-C", temp, ...members], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`could not unpack ${ARCHIVE}: ${result.stderr || result.error}`);
    }
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    for (const dll of DLLS) {
      const from = path.join(temp, STEM, "lib", dll);
      if (!existsSync(from)) throw new Error(`${dll} is missing from ${ARCHIVE}`);
      copyFileSync(from, path.join(destDir, dll));
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Stage the archive and the DLLs. Returns `{ archiveDir, dlls }`, or null on
 * a non-Windows host without `force`.
 */
export async function stageSherpaOnnx({ force = false } = {}) {
  if (platform !== "win32" && !force) {
    console.log(`[stage-sherpa-onnx] platform=${platform}, skipping (Windows only)`);
    return null;
  }
  const targetDir = env.CARGO_TARGET_DIR ? path.resolve(env.CARGO_TARGET_DIR) : path.join(TAURI_DIR, "target");
  mkdirSync(targetDir, { recursive: true });
  const archiveDir = env.SHERPA_ONNX_ARCHIVE_DIR
    ? path.resolve(env.SHERPA_ONNX_ARCHIVE_DIR)
    : path.join(targetDir, "sherpa-onnx-archives");
  const archive = path.join(archiveDir, ARCHIVE);
  if (!(await verified(archive))) {
    if (env.SHERPA_ONNX_ARCHIVE_DIR) {
      throw new Error(
        `${archive} is missing or does not match the pinned SHA-256 ${ARCHIVE_SHA256}. ` +
          "Fix the file or unset SHERPA_ONNX_ARCHIVE_DIR to download it.",
      );
    }
    mkdirSync(archiveDir, { recursive: true });
    rmSync(archive, { force: true });
    console.log(`[stage-sherpa-onnx] downloading ${ARCHIVE_URL}`);
    await download(archive);
  }
  await scrubBuildCache(targetDir);
  const destDir = path.join(TAURI_DIR, "sherpa-bin");
  extractDlls(archive, destDir, targetDir);
  console.log(`[stage-sherpa-onnx] ${ARCHIVE} verified; ${DLLS.join(", ")} staged in ${destDir}`);
  return { archiveDir, dlls: readdirSync(destDir).sort() };
}

if (argv[1] && path.resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const staged = await stageSherpaOnnx({ force: argv.includes("--force") });
    if (staged) console.log(`SHERPA_ONNX_ARCHIVE_DIR=${staged.archiveDir}`);
  } catch (error) {
    console.error(`[stage-sherpa-onnx] ${error.message}`);
    exit(1);
  }
}
