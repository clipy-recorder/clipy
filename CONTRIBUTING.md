# Contributing to Clipy

Thanks for helping. This repository holds the packages that turn a screen recording into an AREC
file on your own machine, and the Clipy desktop app built from them.

## Ways to help

- Pick an issue labelled `good first issue` or `help wanted`. Comment on it
  first so two people do not build the same thing.
- Report a bug in the code here with the "Bug in the code here" template. A
  short screen recording of the problem helps a lot.
- Try the Chrome extension, the iPhone or Android app or the web app, and
  report anything that does not work as you expected with the "Bug in a Clipy
  app" template. Record it with Clipy and paste the share link; the Clipy team
  reproduces it and replies in the issue.
- Suggest a feature for any Clipy app or for the code here with the feature
  template, starting from the problem you want solved.
- Improve the docs. Small fixes are welcome without an issue.
- Share what your agent watched or recorded in
  [Discussions](https://github.com/clipy-recorder/clipy/discussions) (Show
  and tell). Real uses tell us what to build next.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Your first contribution in about 15 minutes

1. Fork the repository and clone your fork.
2. `pnpm install --frozen-lockfile && pnpm test` (Node.js 20.19 or newer).
   The package suites run on macOS, Windows and Linux.
3. Pick an issue labelled
   [`good first issue`](https://github.com/clipy-recorder/clipy/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
   and comment "I'd like to take this". If nobody else has claimed it, it is
   yours; a maintainer confirms in the thread.
4. Make the change on a branch, run the tests again, and open a pull request
   that says what changed and how you tested it.

No issue that fits? Docs fixes, clearer error messages, more tests and new
examples in `plugins/` are always welcome without one.

## What to expect from us

- A first response on every issue and pull request within a working day.
- A claimed issue stays yours for seven days. If you need longer, say so in
  the thread; if it goes quiet, we ask before opening it up again.
- Review comments say what would make the change mergeable, not just what is
  wrong.
- Every merged pull request is credited by name in the release notes, and
  shows on the contributors graph in the README.
- Questions are welcome in the issue thread or in
  [Discussions](https://github.com/clipy-recorder/clipy/discussions); answers
  there help the next person too.

## Layout

| Path | What it is | Tooling |
|---|---|---|
| `packages/moments` | Picks the moments worth a screenshot | TypeScript, Vitest |
| `packages/config` | Provider and transcription settings | TypeScript, Vitest |
| `packages/capture` | Screen capture with ffmpeg | TypeScript, Vitest |
| `packages/transcribe` | Speech to timestamped segments | TypeScript, Vitest |
| `plugins/` | Claude Code plugins and skills: `/watch`, `/record` and the Record with Clipy button | Markdown skills, TypeScript |
| `desktop/` | The Clipy desktop app | Tauri 2 (Rust) and React |

The packages form one pnpm workspace at the root. `desktop/` is its own pnpm
project with its own lockfile.

## Packages

You need Node.js 20.19 or newer and pnpm (the version in `package.json`,
`packageManager`; `corepack enable` picks it up).

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

The capture package's real-recording tests run only on Linux with Xvfb and
FFmpeg built with `x11grab` and `libx264`; if they are skipped, see
[Troubleshooting](#linux-capture-integration-tests-are-skipped). The other
packages run anywhere.

`packages/moments/src/generated/` is generated from the code the hosted
Clipy uses, so both pick moments the same way. Propose changes to it in a
pull request as usual; a maintainer applies the change at its source so the
next sync keeps it.

## Troubleshooting

### Incorrect pnpm version

The root `package.json` pins pnpm to `10.18.0` in its `packageManager` field.
At the repository root, check the version in use:

```sh
pnpm --version
```

It should print `10.18.0`. A temporary pnpm 10.17.1 invocation in this
workspace selected the pinned 10.18.0 automatically and printed no mismatch
error. If your command still reports another version, use Corepack to
activate the pinned one:

```sh
corepack enable
corepack prepare pnpm@10.18.0 --activate
```

Or install that version directly:

```sh
npm install --global pnpm@10.18.0
```

### Node.js is older than 20.19

The packages that require the newer runtime declare `node >=20.19`. Check
your Node.js version:

```sh
node --version
```

If it is below `20.19`, install Node.js 20.19 or newer using the official
installer or a version manager, then reopen your terminal and check again.
With Node.js 20.18.0 and pnpm 10.18.0, `pnpm install --lockfile-only
--offline --frozen-lockfile --ignore-scripts` printed this warning for the
packages that require Node.js 20.19:

```text
WARN  Unsupported engine: wanted: {"node":">=20.19"} (current: {"node":"v20.18.0","pnpm":"10.18.0"})
```

### FFmpeg is missing from PATH for transcription tests

When transcription cannot start FFmpeg, it reports:

```text
ffmpeg was not found. Install ffmpeg (https://ffmpeg.org/download.html) and make sure it is on your PATH, or set CLIPY_FFMPEG to its full path.
```

Install FFmpeg and ensure its executable directory is on `PATH`.

On Windows:

```powershell
winget install Gyan.FFmpeg
```

On macOS:

```bash
brew install ffmpeg
```

On Debian or Ubuntu:

```bash
sudo apt-get install ffmpeg
```

On Fedora:

```bash
sudo dnf install ffmpeg
```

Reopen your terminal after updating `PATH`. On Windows, check that FFmpeg
and FFprobe can both be found and run:

```powershell
where.exe ffmpeg
where.exe ffprobe
ffmpeg -version
ffprobe -version
```

On macOS or Linux, use Bash to check that both executables can be found and
run:

```bash
command -v ffmpeg
command -v ffprobe
ffmpeg -version
ffprobe -version
```

Transcription uses FFmpeg; FFprobe is used by capture when available. If
FFmpeg is installed but the error remains, check that its directory is on
`PATH`, or set `CLIPY_FFMPEG` to the full executable path.

### Linux capture integration tests are skipped

The real-recording tests in `packages/capture/test/linux.integration.test.ts`
are skipped rather than failed if their prerequisites are missing. On
Windows and macOS, they are skipped because they run only on Linux. On Linux,
the tests are skipped if Xvfb or FFmpeg is missing, or if FFmpeg lacks the
`x11grab` input or `libx264` encoder. Missing Xvfb is therefore distinct from
an FFmpeg build without capture support. If the virtual-display helper is
started directly without Xvfb, its source-confirmed error is:

```text
a virtual display needs Xvfb (Debian/Ubuntu: `sudo apt install xvfb`, Fedora: `sudo dnf install xorg-x11-server-Xvfb`)
```

On Debian or Ubuntu, install the CI dependencies:

```bash
sudo apt-get install -y --no-install-recommends ffmpeg xvfb xauth libxtst6
```

Xvfb supplies the virtual display; `xauth` and `libxtst6` support the
integration tests' display authorization and simulated pointer input. FFmpeg
must also include the `x11grab` input and `libx264` encoder. Rerun the capture
tests after installing the dependencies:

```sh
pnpm --filter @clipy/capture test
```

## Desktop app

You need Rust 1.88 or newer, Node.js 20.19 or newer and pnpm. On macOS, Xcode or
the Command Line Tools. On Windows, Visual Studio Build Tools with the C++
workload and a shared FFmpeg 7 build with `FFMPEG_DIR` pointing at it. Full
build notes are in [desktop/README.md](desktop/README.md).

```bash
cd desktop
pnpm install --frozen-lockfile
pnpm tauri:icon
pnpm setup:native-deps            # macOS: downloads the FFmpeg framework
pnpm exec tsc --noEmit
bash scripts/test-rust.sh --locked --lib
node --test scripts/desktop-packaging.test.mjs scripts/speech-permissions.test.mjs
pnpm tauri:dev                    # run the desktop app
```

The crates in `desktop/src-tauri/crates/` have their own `cargo test`.

## Pull requests

- Keep each pull request to one change. Say what it does and how you tested
  it. Screenshots or a short recording help for anything visible.
- CI runs the package tests on Linux, the desktop tests on macOS, and a
  compile check on Windows. Run the relevant
  ones locally first.
- Keep the privacy promise: with no model provider and on-device
  transcription, nothing leaves the machine. A change that sends data
  anywhere new needs a line in the "Where your data goes" table of the
  README.
- Do not add telemetry, analytics or calls to any Clipy service.
- New dependencies need a reason in the pull request. Prefer small, widely
  used crates and packages with a licence compatible with Apache-2.0.

## Licence and sign-off

This repository is licensed under Apache-2.0. By opening a pull request you agree
that your contribution is licensed under the same terms (section 5 of the
licence). There is no contributor licence agreement and no sign-off line to
add.

## Hiring

We also use real issues from this repository in our hiring process.
Candidates work on distinct issues in their own forks, and shortlisted
candidates open pull requests here like anyone else, under the
`hiring-cohort` label. Everyone's contribution is reviewed the same way.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
