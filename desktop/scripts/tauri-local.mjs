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
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, env, exit, platform } from "node:process";
import { fileURLToPath } from "node:url";

import { stageSherpaOnnx } from "./stage-sherpa-onnx.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const tauriTargetDir = resolve(scriptsDir, "..", "src-tauri", "target");

/**
 * macOS with only Xcode Command Line Tools (no full Xcode.app): `cidre`'s build
 * script invokes `xcodebuild` for `pomace.xcodeproj`, which fails under CLT.
 * Put a wrapper around `scripts/xcodebuild-cidre-shims.sh` first on PATH when
 * `/usr/bin/xcodebuild -version` fails.
 */
function ensureMacosXcodebuildShim(childEnv) {
  if (platform !== "darwin") return;
  const probe = spawnSync("/usr/bin/xcodebuild", ["-version"], { stdio: "ignore" });
  if (probe.status === 0) return;

  const shimDir = join(tauriTargetDir, "xcodebuild-shim");
  const shimBin = join(shimDir, "xcodebuild");
  const shimScript = join(scriptsDir, "xcodebuild-cidre-shims.sh");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shimBin, `#!/bin/bash\nexec /bin/bash "${shimScript}" "$@"\n`, "utf8");
  chmodSync(shimBin, 0o755);
  childEnv.PATH = `${shimDir}:${childEnv.PATH ?? ""}`;
  console.log("[tauri-local] Xcode.app not found; using Command Line Tools cidre shim for xcodebuild");
}

/**
 * macOS `tauri dev` runs `target/debug/clipy-desktop` outside an `.app` bundle,
 * so `@executable_path/../Frameworks/Spacedrive.framework` resolves to
 * `target/Frameworks/Spacedrive.framework`. Symlink it to the unpacked native
 * FFmpeg framework (SIP strips `DYLD_FALLBACK_LIBRARY_PATH` across shells).
 */
function ensureMacosFfmpegFrameworkLink() {
  if (platform !== "darwin") return;
  const frameworkSrc = join(tauriTargetDir, "native-deps", "Spacedrive.framework");
  if (!existsSync(frameworkSrc)) return;
  const frameworksDir = join(tauriTargetDir, "Frameworks");
  const frameworkLink = join(frameworksDir, "Spacedrive.framework");
  mkdirSync(frameworksDir, { recursive: true });
  try {
    if (lstatSync(frameworkLink).isSymbolicLink()) unlinkSync(frameworkLink);
    else return;
  } catch {
    // Link does not exist yet.
  }
  symlinkSync(join("..", "native-deps", "Spacedrive.framework"), frameworkLink);
}

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
ensureMacosXcodebuildShim(childEnv);
ensureMacosFfmpegFrameworkLink();
if (platform === "win32") {
  try {
    const staged = await stageSherpaOnnx();
    childEnv.SHERPA_ONNX_ARCHIVE_DIR = staged.archiveDir;
  } catch (error) {
    console.error(`[tauri-local] ${error.message}`);
    exit(1);
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
