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

The capture package's real-recording tests run only on Linux with Xvfb and an
ffmpeg that has x11grab and libx264 (`sudo apt-get install ffmpeg xvfb xauth
libxtst6`); elsewhere they are skipped and the rest of the suite still runs.
The other packages run anywhere.

`packages/moments/src/generated/` is generated from the code the hosted
Clipy uses, so both pick moments the same way. Propose changes to it in a
pull request as usual; a maintainer applies the change at its source so the
next sync keeps it.

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

### Desktop testing by operating system

Desktop CI coverage differs by platform:

- **macOS:** Runs the desktop TypeScript checks, build, Rust library tests, local crate tests and packaging tests.
- **Windows:** Runs the desktop build and a Rust compilation check using `cargo check --locked`. It does not run the same desktop Rust test suite as macOS.
- **Linux:** Runs the root package typecheck and test suites. The capture package's real-recording tests require FFmpeg, Xvfb, XAuth and XTest. Linux is not currently included in the desktop CI test jobs.

When contributing to the desktop application, run the checks relevant to your operating system and describe exactly which commands you tested in your pull request.

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
