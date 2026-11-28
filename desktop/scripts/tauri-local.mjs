/**
 * `tauri dev|build` for the local edition (Clipy Local).
 *
 *     node scripts/tauri-local.mjs dev   [extra tauri args]
 *     node scripts/tauri-local.mjs build [extra tauri args]
 *
 * Runs Tauri with this repository's config (plus the Windows overlay on
 * Windows) and the default Cargo features:
 *
 *     tauri <dev|build> [--config src-tauri/tauri.local.windows.conf.json]
 *
 * On Windows it first stages sherpa-onnx (scripts/stage-sherpa-onnx.mjs): the
 * archive is checked against its pinned SHA-256, the two DLLs are staged for
 * the bundle (the Windows overlay lists them as resources; macOS has none,
 * which is why that overlay is only passed on Windows), and the build gets
 * SHERPA_ONNX_ARCHIVE_DIR so `sherpa-onnx-sys` never downloads an unchecked
 * copy itself.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { argv, env, exit, platform } from "node:process";

import { stageSherpaOnnx } from "./stage-sherpa-onnx.mjs";

const [command, ...extra] = argv.slice(2);
if (command !== "dev" && command !== "build") {
  console.error("usage: node scripts/tauri-local.mjs <dev|build> [tauri args]");
  exit(2);
}

// The default features build the local edition in this repository.
const CARGO_ARGS = [];

// tauri.conf.json is the local edition's config in this repository.
const configs = [];
const childEnv = { ...env };
if (platform === "win32") {
  try {
    const staged = await stageSherpaOnnx();
    childEnv.SHERPA_ONNX_ARCHIVE_DIR = staged.archiveDir;
  } catch (error) {
    console.error(`[tauri-local] ${error.message}`);
    exit(1);
  }

  // Tauri copies bundle resources beside the installed executable, but
  // `tauri dev` runs target/debug/clipy-desktop.exe directly. Make the FFmpeg
  // DLLs discoverable there without requiring contributors to mutate PATH by
  // hand. This also guarantees that bindgen, the linker and the dev app use
  // the same shared build named by FFMPEG_DIR.
  const ffmpegDir = childEnv.FFMPEG_DIR;
  if (ffmpegDir) {
    const pathKey = Object.keys(childEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
    childEnv[pathKey] = [path.join(ffmpegDir, "bin"), childEnv[pathKey]]
      .filter(Boolean)
      .join(path.delimiter);
  }

  configs.push("--config", "src-tauri/tauri.local.windows.conf.json");
}

const result = spawnSync("tauri", [command, ...configs, ...extra, "--", ...CARGO_ARGS], {
  stdio: "inherit",
  env: childEnv,
  // `tauri` is a .cmd shim on Windows.
  shell: platform === "win32",
});
if (result.error) {
  console.error(`[tauri-local] could not run tauri: ${result.error.message}`);
  exit(1);
}
exit(result.status ?? 1);
