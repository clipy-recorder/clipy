/**
 * Stage the shared FFmpeg DLLs so Tauri can bundle them next to the .exe.
 *
 * Windows links FFmpeg dynamically, so `avutil-59.dll` and friends must sit
 * beside the executable on the end user's machine. On a dev box they resolve
 * from `PATH` (the FFmpeg `bin` directory), which is exactly why this was
 * invisible locally and only failed once an installer reached someone else:
 *
 *     The code execution cannot proceed because avutil-59.dll was not found.
 *
 * `bundle.resources` in tauri.windows.conf.json cannot read `FFMPEG_DIR`, so
 * this copies DLLs to a fixed in-repo path. The Windows beforeDevCommand and
 * beforeBuildCommand run it before Rust compilation: tauri-build resolves
 * resources in build.rs, so beforeBundleCommand would run too late.
 *
 * No-op on non-Windows.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, exit, platform } from "node:process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.join(HERE, "..", "src-tauri", "ffmpeg-bin");

if (platform !== "win32") {
  console.log(`[stage-ffmpeg-dlls] platform=${platform} — skipping (Windows only)`);
  exit(0);
}

const ffmpegDir = env.FFMPEG_DIR;
if (!ffmpegDir) {
  console.error(
    "[stage-ffmpeg-dlls] FFMPEG_DIR is not set.\n" +
      "  It must point at the FFmpeg 7.x *shared* build used to compile, e.g. C:\\ffmpeg.\n" +
      "  Without it the installer ships without avutil-59.dll and the app will not start\n" +
      "  on any machine that lacks FFmpeg on PATH.",
  );
  exit(1);
}

const binDir = path.join(ffmpegDir, "bin");
if (!existsSync(binDir)) {
  console.error(`[stage-ffmpeg-dlls] no bin directory at ${binDir}`);
  exit(1);
}

mkdirSync(DEST, { recursive: true });

const dlls = readdirSync(binDir).filter((f) => f.toLowerCase().endsWith(".dll"));
if (dlls.length === 0) {
  console.error(
    `[stage-ffmpeg-dlls] no DLLs in ${binDir}.\n` +
      "  A 'shared' FFmpeg build is required; the 'static' builds contain none.",
  );
  exit(1);
}

let bytes = 0;
for (const dll of dlls) {
  const from = path.join(binDir, dll);
  const to = path.join(DEST, dll);
  // Equal file sizes do not imply equal DLLs. Refresh from the same build
  // used by the linker, including on repeated builds with a cached target.
  copyFileSync(from, to);
  bytes += statSync(from).size;
}

// Tauri bundles every staged DLL, including leftovers from a previous build.
const currentDlls = new Set(dlls.map((dll) => dll.toLowerCase()));
for (const entry of readdirSync(DEST, { withFileTypes: true })) {
  const name = entry.name.toLowerCase();
  if (entry.isFile() && name.endsWith(".dll") && !currentDlls.has(name)) {
    unlinkSync(path.join(DEST, entry.name));
  }
}

console.log(
  `[stage-ffmpeg-dlls] ${dlls.length} DLL(s) staged in ${DEST} (${(bytes / 1024 / 1024).toFixed(1)} MB)`,
);
