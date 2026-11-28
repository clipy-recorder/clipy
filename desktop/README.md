# Clipy Local, the desktop app

A menu-bar app for macOS and a system-tray app for Windows that records your
screen, camera and voice and turns each take into an AREC file on your own
machine: the video, the transcript, the moments that matter and a screenshot
of each, ready for an AI agent to read. No account, nothing uploaded.

The app is called **Clipy Local** (`Clipy Local.app` on macOS, "Clipy Local"
in the Windows Start menu, in the menu bar or tray, and in System Settings
when macOS asks for permissions). You build it yourself from this
repository. It is built with Tauri 2 (Rust) and a Vite + React window.

Clipy Local is not the Clipy app. The full Clipy app, with share links anyone
can watch, AI with no keys to manage, search across all your recordings and
team workspaces, is a separate download at
[clipy.online/download](https://clipy.online/download). The two can be
installed side by side.

## Build it

You need Rust 1.88 or newer, Node.js 20.19 or newer and pnpm. On macOS, Xcode or
the Command Line Tools (macOS 12.3 or newer to run the app). On Windows, use
Visual Studio Build Tools 2022 with the **Desktop development with C++**
workload and a Windows 10 or 11 SDK. You also need LLVM 18 and FFmpeg 7 shared
libraries; the reproducible setup is below.

```bash
cd desktop
pnpm install --frozen-lockfile
pnpm tauri:icon       # once: generates the app icons from src-tauri/app-icon.svg
pnpm setup:native-deps  # macOS, once: downloads the FFmpeg framework
pnpm tauri:dev        # run it
pnpm tauri:build      # build the app bundle or installer
```

The local edition is the default: `cargo build` and `pnpm tauri:build` need no
feature flags, and `src-tauri/tauri.conf.json` is the local edition's config
(app name Clipy Local, identifier `online.clipy.local`, `clipy-local://`
links, no updater). The `cloud` feature in `Cargo.toml` is the official
Clipy app; its sources are not in this repository and building with it stops
with an error that says so.

### FFmpeg

The recorder encodes through FFmpeg 7.

- macOS: `pnpm tauri:build` runs `pnpm setup:native-deps`, which downloads a
  prebuilt FFmpeg framework into `src-tauri/target/native-deps/`. Run it once
  yourself before the first `pnpm tauri:dev`. Without it, Homebrew's
  `ffmpeg@7` works for compiling (`src-tauri/.cargo/config.toml`).
- Windows: the Rust FFmpeg bindings also need libclang. The current dependency
  stack is verified with LLVM 18.1.8; do not use winget's unversioned latest
  LLVM (LLVM 23 produces invalid opaque FFmpeg structs with bindgen 0.70).
  In PowerShell, install the pinned LLVM and FFmpeg shared builds and set
  `FFMPEG_DIR` for this shell and future shells:

  ```powershell
  winget install --exact --id LLVM.LLVM --version 18.1.8
  winget install --exact --id Gyan.FFmpeg.Shared --version 7.1.1

  $avcodec = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" `
    -Recurse -File -Filter avcodec.lib |
    Where-Object FullName -Like '*Gyan.FFmpeg.Shared*' |
    Select-Object -First 1
  if (-not $avcodec) { throw 'The FFmpeg shared development files were not found' }

  $env:FFMPEG_DIR = Split-Path -Parent (Split-Path -Parent $avcodec.FullName)
  [Environment]::SetEnvironmentVariable('FFMPEG_DIR', $env:FFMPEG_DIR, 'User')
  ```

  `FFMPEG_DIR` must be the folder containing `bin`, `include` and `lib`, not
  the `bin` folder itself. The pinned Gyan build includes libx264 for H.264
  recording. The build wrapper adds its `bin` folder to the dev app's `PATH`
  and copies the DLLs beside the installed app. If bindgen still reports that
  it cannot find `libclang.dll`, open a new terminal or set
  `LIBCLANG_PATH=C:\Program Files\LLVM\bin`.

### macOS permissions

A self-built app is signed ad hoc. macOS ties the Screen Recording and
Accessibility permissions to the signature, so after each rebuild you may
need to switch Clipy Local off and on again in System Settings, Privacy &
Security.

### Windows installation and permissions

`pnpm tauri:build` writes an NSIS installer under
`src-tauri/target/release/bundle/nsis/`. The self-built installer is unsigned,
so SmartScreen may show **Windows protected your PC**. For an artifact you
built from this checkout, choose **More info**, verify the app and publisher
details, then choose **Run anyway**. Do not bypass this warning for an
installer you did not build or otherwise trust.

Allow desktop apps to use the microphone under **Settings > Privacy &
security > Microphone**. Enable camera access there as well if you want to
record a webcam.

### Smoke-test the app

Install and launch the result, choose a display and microphone, and record at
least 30 seconds while speaking. Stop the take and wait for local processing
to finish. Open the take from Clipy Local's home screen; **Show in Explorer**
reveals its `recording.arec`. Open that AREC in Clipy Local and confirm the
video plays and the spoken audio is present.

## Test it

```bash
pnpm exec tsc --noEmit
node --test scripts/desktop-packaging.test.mjs scripts/speech-permissions.test.mjs
bash scripts/test-rust.sh --locked --lib   # macOS: finds the FFmpeg framework for you
```

The Bash Rust helper is macOS-only. The Windows Rust-test environment and
platform test matrix are tracked separately; `pnpm tauri:dev` and
`pnpm tauri:build` in the build steps compile the Windows Rust application for
this guide.

`src-tauri/crates/clipy-local-moments` (moment selection),
`src-tauri/crates/clipy-local-stt` (transcription) and
`src-tauri/crates/clipy-local-edition` are separate crates with their own
`cargo test`.

## Drive it from an agent

On macOS, the official Clipy CLI records through Clipy Local with `--local`,
so an agent can start a take, act, and read the result. Keep Clipy Local
running, then:

```bash
clipy record --local --source mac-screen --for 60
clipy session start --local --source mac-screen    # then clipy mark "...", then:
clipy session stop --local
```

Each prints the path of the take's `recording.arec` last. `clipy sources
--local --source mac-screen` lists the windows and displays it can record, for
`--window` and `--display`. The CLI talks to Clipy Local over a Unix socket in
its app data folder that only your user can open; nothing goes over the
network. The first take an agent starts asks for your consent in the app.

## What stays on your machine

Everything, unless you choose otherwise in Settings:

| Choice | What leaves your machine |
|---|---|
| No model provider, on-device transcription | Nothing. |
| A model provider for spoken moments (OpenRouter, OpenAI, Gemini, Groq or a custom URL) | The transcript text, the labels of what you clicked and a bounded sample of pointer and key events go to that provider. Video and screenshots do not. With OpenRouter, requests also name the app (`HTTP-Referer: https://clipy.online`, `X-Title: Clipy`). |
| Ollama or LM Studio | Nothing: the model runs on your machine. |
| A transcription key (OpenAI, Groq, Deepgram, AssemblyAI, ElevenLabs or Gemini) | The audio goes to that provider. |

macOS transcribes with Apple's on-device speech recognition; on macOS 26 and
later, macOS may download Apple's speech model for your language the first
time (no audio is sent). On Windows you
download a speech model once ("English, fast" or "All languages") or use your
own transcription key. Clipy Local has no telemetry.

## Contributing

Build and test steps, the pull request checklist and how issues are labelled
are in [CONTRIBUTING.md](../CONTRIBUTING.md) at the root of this repository.

## Licence

Apache-2.0, like the rest of this repository.
