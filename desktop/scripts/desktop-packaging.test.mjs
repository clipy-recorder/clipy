import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const readConfig = (name) => JSON.parse(readFileSync(path.join(desktopDir, "src-tauri", name), "utf8"));

test("macOS config has no Windows resources or staging hooks", () => {
  const config = readConfig("tauri.conf.json");
  assert.deepEqual(Object.keys(config.bundle.resources).sort(), [
    "LICENSES/Apache-2.0.txt",
  ]);
  assert.equal(config.build.beforeBuildCommand, "pnpm run build");
  assert.equal(config.build.beforeDevCommand, "pnpm run dev");
  assert.equal(config.build.beforeBundleCommand, undefined);
  assert.deepEqual(config.bundle.macOS.frameworks, ["target/native-deps/Spacedrive.framework"]);
});

test("Windows adds DLLs beside the executable and stages before Rust dev/build", () => {
  const config = readConfig("tauri.windows.conf.json");
  assert.equal(config.bundle.resources["ffmpeg-bin/*.dll"], "./");
  assert.equal(config.bundle.resources["segmentation/*"], "segmentation/");
  const stage = "node scripts/stage-ffmpeg-dlls.mjs && node scripts/stage-segmentation-assets.mjs";
  assert.equal(config.build.beforeBuildCommand, `${stage} && pnpm run build`);
  assert.equal(config.build.beforeDevCommand, `${stage} && pnpm run dev`);
  assert.equal(config.build.beforeBundleCommand, undefined);
});

function segmentationFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "clipy-segmentation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(path.join(desktopDir, "scripts/stage-segmentation-assets.mjs"), path.join(root, "scripts/stage-segmentation-assets.mjs"));
  const wasm = path.join(root, "node_modules/@mediapipe/tasks-vision/wasm");
  const dest = path.join(root, "src-tauri/segmentation");
  mkdirSync(wasm, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const run = (platform) => spawnSync(process.execPath, [
    "--input-type=module", "-e",
    `import { syncBuiltinESMExports } from 'node:module';
     Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
     syncBuiltinESMExports();
     await import('./scripts/stage-segmentation-assets.mjs');`,
  ], { cwd: root, encoding: "utf8" });
  return { wasm, dest, run };
}

test("segmentation staging is a no-op on macOS", (t) => {
  const { dest, run } = segmentationFixture(t);
  const result = run("darwin");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(dest), []);
});

test("Windows stages the MediaPipe runtime beside the committed models", (t) => {
  const { wasm, dest, run } = segmentationFixture(t);
  writeFileSync(path.join(dest, "selfie_segmenter.tflite"), "model");
  writeFileSync(path.join(dest, "selfie_segmenter.onnx"), "model");
  writeFileSync(path.join(wasm, "vision_wasm_internal.js"), "loader");
  writeFileSync(path.join(wasm, "vision_wasm_internal.wasm"), "binary");
  writeFileSync(path.join(wasm, "vision_wasm_nosimd_internal.wasm"), "unused");
  const result = run("win32");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(dest).sort(), [
    "selfie_segmenter.onnx", "selfie_segmenter.tflite", "vision_wasm_internal.js", "vision_wasm_internal.wasm",
  ]);
});

test("Windows segmentation staging fails without the models or the package", (t) => {
  const { wasm, dest, run } = segmentationFixture(t);
  let result = run("win32");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /selfie_segmenter\.tflite is missing/);
  writeFileSync(path.join(dest, "selfie_segmenter.tflite"), "model");
  result = run("win32");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /selfie_segmenter\.onnx is missing/);
  writeFileSync(path.join(dest, "selfie_segmenter.onnx"), "model");
  result = run("win32");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run pnpm install/);
  assert.equal(existsSync(path.join(wasm, "vision_wasm_internal.js")), false);
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "clipy-packaging-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(path.join(desktopDir, "scripts/stage-ffmpeg-dlls.mjs"), path.join(root, "scripts/stage-ffmpeg-dlls.mjs"));
  const ffmpeg = path.join(root, "ffmpeg");
  const bin = path.join(ffmpeg, "bin");
  mkdirSync(bin, { recursive: true });
  const dest = path.join(root, "src-tauri/ffmpeg-bin");
  // Run the real staging script against temporary files. Only host detection
  // is substituted, so Windows filesystem cases can also run on macOS CI.
  const run = (platform, ffmpegDir = ffmpeg) => spawnSync(process.execPath, [
    "--input-type=module", "-e",
    `import { syncBuiltinESMExports } from 'node:module';
     Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
     syncBuiltinESMExports();
     await import('./scripts/stage-ffmpeg-dlls.mjs');`,
  ], { cwd: root, env: { ...process.env, FFMPEG_DIR: ffmpegDir }, encoding: "utf8" });
  return { root, bin, dest, run };
}

test("staging is a no-op on macOS without FFMPEG_DIR", (t) => {
  const { dest, run } = fixture(t);
  const result = run("darwin", "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(dest), false);
});

test("restaging FFmpeg drops DLLs removed from the shared build", (t) => {
  const { bin, dest, run } = fixture(t);
  writeFileSync(path.join(bin, "avutil-59.dll"), "current");
  writeFileSync(path.join(bin, "old-codec.DLL"), "old");
  const first = run("win32");
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(path.join(dest, "old-codec.DLL")));

  rmSync(path.join(bin, "old-codec.DLL"));
  writeFileSync(path.join(dest, "notes.txt"), "keep");
  const second = run("win32");
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readdirSync(dest).sort(), ["avutil-59.dll", "notes.txt"]);
});

test("Windows stages DLLs on a clean checkout, excluding executables", (t) => {
  const { bin, dest, run } = fixture(t);
  writeFileSync(path.join(bin, "avutil-59.dll"), "first");
  writeFileSync(path.join(bin, "avcodec-61.dll"), "codec");
  writeFileSync(path.join(bin, "ffmpeg.exe"), "exe");
  const result = run("win32");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(dest).sort(), ["avcodec-61.dll", "avutil-59.dll"]);
  assert.equal(readFileSync(path.join(dest, "avutil-59.dll"), "utf8"), "first");
});

test("Windows rejects missing FFmpeg configuration and empty shared builds", (t) => {
  const { root, run } = fixture(t);
  for (const [dir, message] of [
    ["", /FFMPEG_DIR is not set/],
    [path.join(root, "missing"), /no bin directory/],
    [path.join(root, "ffmpeg"), /no DLLs/],
  ]) {
    const result = run("win32", dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});

test("Windows refreshes changed DLL bytes even when their size is unchanged", (t) => {
  const { bin, dest, run } = fixture(t);
  writeFileSync(path.join(bin, "avutil-59.dll"), "first");
  assert.equal(run("win32").status, 0);
  writeFileSync(path.join(bin, "avutil-59.dll"), "later");
  const result = run("win32");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(dest, "avutil-59.dll"), "utf8"), "later");
});

test("the local edition's ad-hoc macOS build skips the hardened runtime", () => {
  // Hardened runtime enforces library validation, and ad-hoc signed FFmpeg
  // dylibs fail it, so the self-built app would crash at launch.
  const local = readConfig("tauri.conf.json");
  assert.equal(local.bundle.macOS.signingIdentity, "-");
  assert.equal(local.bundle.macOS.hardenedRuntime, false);
});

test("the local edition bundles the sherpa-onnx DLLs on Windows only", () => {
  // tauri.conf.json is the local edition's config here: only the Windows
  // overlay adds files.
  assert.deepEqual(readConfig("tauri.conf.json").bundle.resources, { "LICENSES/Apache-2.0.txt": "LICENSES/Apache-2.0.txt" });
  const windows = readConfig("tauri.local.windows.conf.json");
  assert.deepEqual(windows.bundle.resources, { "sherpa-bin/*.dll": "./" });
  const pkg = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
  assert.equal(pkg.scripts["tauri:dev"], "node scripts/tauri-local.mjs dev");
  assert.equal(pkg.scripts["tauri:build"], "pnpm run setup:native-deps && node scripts/tauri-local.mjs build");
  const wrapper = readFileSync(path.join(desktopDir, "scripts/tauri-local.mjs"), "utf8");
  assert.match(wrapper, /const CARGO_ARGS = \[\];/);
  assert.match(wrapper, /tauri\.local\.windows\.conf\.json/);
});

const SHERPA_ARCHIVE = "sherpa-onnx-v2.0.2-win-x64-shared-MT-Release-lib.tar.bz2";

function sherpaFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "clipy-sherpa-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "src-tauri/target"), { recursive: true });
  copyFileSync(path.join(desktopDir, "scripts/stage-sherpa-onnx.mjs"), path.join(root, "scripts/stage-sherpa-onnx.mjs"));
  const archives = path.join(root, "archives");
  mkdirSync(archives);
  // The real staging script; only host detection is substituted.
  const run = (platform, archiveDir = archives) => spawnSync(process.execPath, [
    "--input-type=module", "-e",
    `import { syncBuiltinESMExports } from 'node:module';
     Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
     syncBuiltinESMExports();
     const { stageSherpaOnnx } = await import('./scripts/stage-sherpa-onnx.mjs');
     try { console.log(JSON.stringify(await stageSherpaOnnx())); }
     catch (error) { console.error(error.message); process.exit(1); }`,
  ], {
    cwd: root,
    env: { ...process.env, SHERPA_ONNX_ARCHIVE_DIR: archiveDir, CARGO_TARGET_DIR: "" },
    encoding: "utf8",
  });
  return { root, archives, run };
}

test("sherpa-onnx staging is a no-op off Windows", (t) => {
  const { root, run } = sherpaFixture(t);
  const result = run("darwin");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(path.join(root, "src-tauri/sherpa-bin")), false);
});

test("sherpa-onnx staging refuses an archive that does not match the pinned checksum", (t) => {
  const { root, archives, run } = sherpaFixture(t);
  let result = run("win32");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or does not match the pinned SHA-256/);
  writeFileSync(path.join(archives, SHERPA_ARCHIVE), "tampered");
  result = run("win32");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the pinned SHA-256/);
  assert.equal(existsSync(path.join(root, "src-tauri/sherpa-bin")), false);
});

// The real archive is 8 MB; set SHERPA_ONNX_TEST_ARCHIVE_DIR to a folder that
// holds it to run the full staging path.
const realArchives = process.env.SHERPA_ONNX_TEST_ARCHIVE_DIR;
test("sherpa-onnx staging verifies, scrubs the build cache and stages two DLLs", {
  skip: !realArchives || !existsSync(path.join(realArchives ?? "", SHERPA_ARCHIVE)),
}, (t) => {
  const { root, run } = sherpaFixture(t);
  const cache = path.join(root, "src-tauri/target/sherpa-onnx-prebuilt");
  const stem = SHERPA_ARCHIVE.replace(/\.tar\.bz2$/, "");
  mkdirSync(path.join(cache, stem, "lib"), { recursive: true });
  writeFileSync(path.join(cache, SHERPA_ARCHIVE), "unverified download");
  const result = run("win32", realArchives);
  assert.equal(result.status, 0, result.stderr);
  const staged = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(staged.archiveDir, path.resolve(realArchives));
  assert.deepEqual(staged.dlls, ["onnxruntime.dll", "sherpa-onnx-c-api.dll"]);
  assert.deepEqual(readdirSync(path.join(root, "src-tauri/sherpa-bin")).sort(), staged.dlls);
  assert.equal(existsSync(path.join(cache, SHERPA_ARCHIVE)), false, "unverified cached archive removed");
  assert.equal(existsSync(path.join(cache, stem)), false, "copy unpacked from it removed");
});
