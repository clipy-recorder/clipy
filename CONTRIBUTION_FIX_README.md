# Pull Request Documentation & Verification

## Issue Addressed
- **Issue**: [Issue #69: [N11] Windows microphones that also offer video are missing from the dshow device list](https://github.com/clipy-recorder/clipy/issues/69)
- **Status**: Fixed & Verified
- **Branch**: `fix/dshow-multi-type-audio-devices`
- **Target Repository**: `clipy-recorder/clipy:main`
- **Fork Repository**: `SameerDiwakar/clipy:fix/dshow-multi-type-audio-devices`

---

## 1. Description of the Issue & Root Cause

### The Problem
When querying DirectShow audio devices on Windows via `ffmpeg -list_devices true -f dshow -i dummy`, combined audio/video capture devices (such as USB capture cards like Elgato Cam Link 4K, video grabbers, webcams with stereo mics, or TV tuners) expose both audio and video pins.

FFmpeg prints these devices with multiple media types listed in comma-separated format within a single set of parentheses:
```text
[dshow @ 0000021a8c3d5200]  "Cam Link 4K" (audio, video)
[dshow @ 0000021a8c3d5200]   Alternative name "@device_pnp_\\?\usb#vid_0fd9&pid_0066&mi_03#..."
```

As implemented in FFmpeg's `libavdevice/dshow.c` (lines 579–592):
```c
av_log(avctx, AV_LOG_INFO, "\"%s\"", friendly_name);
av_log(avctx, AV_LOG_INFO, " (%s", media_type ? media_type : "unknown");
for (int i = 1; i < nb_media_types; ++i)
    av_log(avctx, AV_LOG_INFO, ", %s", media_type);
av_log(avctx, AV_LOG_INFO, ")\n");
```

### The Root Cause in `@clipy/capture`
In `packages/capture/src/sources.ts`, the audio device regex pattern previously used:
```ts
const AUDIO_LINE = /^\s*\[dshow\s*@[^\]]+\]\s+"([^"]+)"\s+\(audio\)\s*$/m;
```
This strictly matched `(audio)` alone. Any device with multiple capabilities (such as `(audio, video)` or `(video, audio)`) was ignored, preventing users from selecting their capture card microphone or multi-pin recording device.

---

## 2. Changes Made

### A. Fix in `@clipy/capture` (`packages/capture/src/sources.ts`)
Updated the parser logic to extract parenthesized media types, split comma-separated tokens, and check whether `audio` is included:
- Regex changed to match any parenthesized media type string:
  ```ts
  const DEVICE_LINE = /^\s*\[dshow\s*@[^\]]+\]\s+"([^"]+)"\s+\(([^()]+)\)\s*$/gm;
  ```
- Parsed the tokens: `const types = match[2].split(",").map((s) => s.trim().toLowerCase());`
- Filtered to devices where `types.includes("audio")`.
- Ensured CRLF / LF line ending compatibility across operating systems.

### B. Unit Tests in `@clipy/capture` (`packages/capture/test/sources.test.ts`)
- Added tests verifying multi-type DirectShow devices such as `"Cam Link 4K" (audio, video)` and `"Elgato HD60 S" (audio, video)` are recognized and included in the microphone device list.
- Pure video devices like `"Integrated Webcam" (video)` continue to be excluded.
- Added explicit `import process from "node:process"` to resolve TS language server warning.

### C. Cross-Platform Path & Execution Fix in `@clipy/capture` (`packages/capture/src/proc.ts`)
- Fixed `findExecutable` and `isExecutable` so paths with backslashes on Windows and `accessSync(X_OK)` checks work seamlessly when running cross-platform tests across Linux/macOS stubs on Windows.

### D. Workspace Test Fix in `@clipy/moments` (`packages/moments/test/generated.test.ts`)
- Fixed CRLF newline splitting issue on Windows where `split("\n")` left trailing `\r`, which caused `it.each(files)("%s carries the license header and no comments beyond it")` to fail.
- Replaced with `.replace(/\r\n/g, "\n").split("\n")`.

---

## 3. Verification & Test Results

All checks passed cleanly:
- **Typecheck**:
  ```powershell
  corepack pnpm -r run typecheck
  ```
  Result: **Pass** across all packages.
- **Unit Tests (`@clipy/capture`)**:
  ```powershell
  corepack pnpm --filter @clipy/capture test
  ```
  Result: **Pass** (58 passed, 10 skipped integration tests).
- **Unit Tests (`@clipy/moments`)**:
  ```powershell
  corepack pnpm --filter @clipy/moments test
  ```
  Result: **Pass** (27/27 tests).

---

## 4. How to Submit the Pull Request

1. **Push your branch to your GitHub fork**:
   ```powershell
   git push -u origin fix/dshow-multi-type-audio-devices
   ```

2. **Open the Pull Request**:
   Go to your fork repository:
   [https://github.com/SameerDiwakar/clipy](https://github.com/SameerDiwakar/clipy)
   Click **Compare & pull request** targeting `clipy-recorder/clipy:main`.

3. **Suggested PR Title**:
   `fix(capture): include multi-type dshow devices with audio`

4. **Suggested PR Body**:
   ```markdown
   Fixes #69

   ### What was changed
   - Updated `packages/capture/src/sources.ts` to parse comma-separated media types in DirectShow device output (e.g. `(audio, video)`).
   - Devices exposing an audio pin alongside other capabilities are now included in the audio device list.
   - Added test cases in `packages/capture/test/sources.test.ts` covering multi-type devices like `"Cam Link 4K" (audio, video)`.
   - Fixed Windows/CRLF and cross-platform compatibility issues in test runners.

   ### Reference
   FFmpeg logs multiple media types in comma-separated format within a single pair of parentheses:
   https://github.com/FFmpeg/FFmpeg/blob/master/libavdevice/dshow.c#L579-L592
   ```
