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
the Command Line Tools (macOS 12.3 or newer to run the app). On Windows,
Visual Studio Build Tools with the C++ workload, and FFmpeg 7 shared
libraries (see below).

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
- Windows: download a shared FFmpeg 7 build, set `FFMPEG_DIR` to its folder
  (the one with `bin`, `include` and `lib`), and the build copies its DLLs next
  to the app. The recorder encodes H.264 with libx264 on Windows, so the build
  needs FFmpeg with x264.

### macOS permissions

A self-built app is signed ad hoc. macOS ties the Screen Recording and
Accessibility permissions to the signature, so after each rebuild you may
need to switch Clipy Local off and on again in System Settings, Privacy &
Security.

## Test it

The desktop test commands and CI coverage differ by operating system.

### macOS

The desktop CI runs the following checks on macOS:

```bash
pnpm install --frozen-lockfile
node scripts/setup-native-deps.mjs
pnpm tauri:icon
pnpm exec tsc --noEmit
pnpm run build
brew install ffmpeg
bash scripts/test-rust.sh --locked --lib
```

The local Rust crates also have separate test suites:

```bash
cd src-tauri/crates/clipy-local-edition
cargo test --locked

cd ../clipy-local-moments
cargo test --locked

cd ../clipy-local-stt
cargo test --locked --no-default-features

cd ../../..
node --test scripts/desktop-packaging.test.mjs scripts/speech-permissions.test.mjs
```

### Windows

The desktop CI runs the frontend build and checks Rust compilation:

```powershell
pnpm tauri:icon
pnpm run build
node scripts/stage-ffmpeg-dlls.mjs
node scripts/stage-segmentation-assets.mjs
Set-Location src-tauri
cargo check --locked
```

The Windows build requires Visual Studio Build Tools with the C++ workload and a shared FFmpeg 7 build configured through `FFMPEG_DIR`.

The macOS Rust test script uses `DYLD_FALLBACK_LIBRARY_PATH` and should not be treated as a Windows test command.

### Linux

The root package CI runs:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

The capture package's real-recording tests run on Linux with FFmpeg, Xvfb, XAuth and XTest installed.

The desktop CI test jobs currently run on macOS and Windows, not Linux.

For additional desktop build requirements, see the sections above.
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
