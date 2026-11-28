---
name: watch
description: Watch a YouTube video, a Loom link or a video file for the user and answer questions about it with timestamps. Use whenever the user shares a YouTube URL, a Loom share link or a path to a video file, or asks you to watch, summarize, take notes on or follow along with a video ("watch this", "what does this video say", "implement what this video shows").
argument-hint: "<YouTube URL | Loom link | path to a video file> [question]"
tags: [video, youtube, loom, transcript, arec, claude-code]
allowed-tools: Read, Bash(command -v clipy), Bash(clipy context import *), Bash(clipy context read *), Bash(clipy local status*), Bash(clipy doctor*), Bash(npx -y @clipy/cli@0.21.0 context import *), Bash(npx -y @clipy/cli@0.21.0 context read *), Bash(npx -y @clipy/cli@0.21.0 local status*), Bash(npx -y @clipy/cli@0.21.0 doctor*)
---

# Watch a video

The user wants you to watch a video and then answer their question about it.
Their input: `$ARGUMENTS`

If that is empty (you picked this skill up on your own), take the video and the
question from the user's latest message.

The first argument is the video: a YouTube URL, a Loom share link, or a path to
a video file on this machine. Everything after it is the question. If the path
has spaces, the user may have quoted it; treat the quoted part as the video. If
there is no argument at all, ask which video to watch and stop.

You watch the video through the Clipy CLI. It turns the video into an AREC
file, `recording.arec`: the transcript, the key moments and timestamps, in
plain Markdown, written to a folder on this machine. AREC is an open format
(https://arecformat.org). Then you read that file and answer.

## 1. Find the CLI

Run `command -v clipy`. If it prints a path, use `clipy` in the commands
below. If it prints nothing, use `npx -y @clipy/cli@0.21.0` in place of
`clipy` (it needs Node.js 18.17 or later). Do not install anything globally
without asking; mention that `npm i -g @clipy/cli` makes later runs faster.

## 2. Import the video

### A YouTube URL or a Loom share link

```bash
clipy context import "<url>" --json
```

No Clipy account and no login. YouTube captions and Loom transcripts are
fetched on this machine, and nothing is sent to Clipy. Do not add `--sync`
unless the user asks to save the video to their Clipy library: `--sync` needs
a Clipy account and saves the transcript, the AREC document and the selected
frames (never the video itself) to their private Clipy library.

Useful flags, only when they apply:

- `--language <code>` picks a caption language, for example `--language es`.
- `--transcript <file.vtt|file.srt|transcript.json>` uses captions the user
  already has.

### A video file on this machine

The file is transcribed on this machine by an on-device speech model. First
check that the model and the speech engine are installed:

```bash
clipy local status
```

If it prints `unknown command: local`, this copy of the Clipy CLI has no
on-device transcription. If `clipy` is a global install, ask the user before
running `npm i -g @clipy/cli`, or use `npx -y @clipy/cli@0.21.0` in
its place, and check again. If a current CLI says the same, do not try the
`--local` import. Ask for a caption file and run
`clipy context import "<path to the file>" --transcript <file.vtt> --json`
(no `--local`; it prints `contextPath` like a URL import), or ask for a
YouTube or Loom link to the same video.

Look at the "local models" and "local speech" lines. If the model is not
downloaded or the speech engine is not installed, tell the user this is a
one-time setup, say what it downloads, and **ask before running it**:

```bash
clipy models download english-fast   # on-device English speech model, about 104 MB
clipy speech install                 # the engine that runs it, about 35 MB
```

For a video that is not in English, offer `clipy models download multilingual`
(about 161 MB) followed by `clipy local setup --transcribe local-multilingual`.
Run these only after the user agrees. If they decline and have a caption file,
add `--transcript <file.vtt>` to the import instead.

Then import the file:

```bash
clipy context import "<path to the file>" --local --json
```

With `--local` the video, audio and screenshots stay on this machine and
nothing is uploaded to Clipy. It also picks the key moments and saves a
screenshot of each. (If the user has set their own model provider or
transcription key with `clipy local setup`, the transcript or audio goes to
that provider under its terms; the default uses neither.)

## 3. Read the result

With `--json` the command prints one JSON object.

- A URL import prints `contextPath`, the full path of `recording.arec`, and
  `bundlePath`, its folder.
- A `--local` file import prints `arec`, the full path of `recording.arec`,
  and `dir`, its folder, which also holds the screenshots under `frames/`.
- A failure prints `"ok": false` with `error`, and with `code` and
  `remediation` for the failures in the table below. A `--local` failure may
  carry only `error` (and `keptVideo` when the video was saved); read it.

Read `recording.arec` with the Read tool. It is Markdown. When the question is
about something on screen and the AREC lists key moments with frames, read the
frame images it names. Check `warnings` in the JSON: a transcript gap or a
missing piece is reported there. A `--local` import still succeeds when the
speech model is missing: `transcript.engine` is `failed`, `warnings` names the
model, and the AREC has screenshots but no transcript. Tell the user, offer
the one-time setup from step 2, and import again after it.

## 4. Answer

- If the user asked a question, answer it from the AREC and cite the moments
  that support it as timestamps, like `[03:12]`. Quote the speaker briefly
  when the exact words matter.
- If there was no question, summarize: one line on what the video is, the key
  points with timestamps, then any steps, decisions or action items.
- For a YouTube video, you may link a moment as
  `https://www.youtube.com/watch?v=<id>&t=<seconds>s`.
- Say so plainly when the transcript does not cover what was asked, for
  example something shown on screen but never said. Do not guess.
- End with the path of `recording.arec` so the user can reuse it.

## When something fails

Read `code` and `remediation` from the JSON and act on them:

| `code` | What to do |
|---|---|
| `no_captions` | The video has no usable captions. If the error lists other languages, re-run with `--language <code>`. Otherwise offer `--transcript <file.vtt>`, or, if the user has the video file, a `--local` import of it. If the error says local files cannot be transcribed, this CLI has no on-device transcription: see the note under "A video file on this machine". |
| `invalid_url` | Only a single video works, not a channel, playlist, folder or search page, and the Loom link must point at a video that exists. Ask for the video's own link. |
| `source_unreadable` | The path is not a readable file. Paths are relative to the current folder; check it exists and quote it if it has spaces. |
| `source_private` | The Loom video is private or password protected. Ask for a public share link. |
| `loom_unreachable` | Loom did not answer. Wait a moment and try once more. |
| `ytdlp_missing` | The YouTube helper could not be installed. Follow `remediation`, then run `clipy doctor`. |
| `ytdlp_download_403` | YouTube refused the download. The CLI already retried, so do not run it again now; follow `remediation`. |
| `ffmpeg_missing` | Install ffmpeg (`brew install ffmpeg` on macOS, `winget install Gyan.FFmpeg` on Windows, `sudo apt install ffmpeg` on Linux), then run `clipy doctor`. |
| `speech_engine_required` | Ask the user, then run `clipy speech install` and import again. |
| `youtube_sign_in_required`, or `unknown` with an `error` that says "Sign in to confirm you're not a bot" | YouTube is refusing requests from this network, which happens on cloud servers, CI runners and some VPNs. Running it again will not help, and `--transcript` does not get around it for a YouTube URL. Tell the user, and suggest running `/watch` on their own computer, or a `--local` import if they have the video file. With CLI 0.22.0 or later, offer one more option and ask before using it: re-run with `CLIPY_YTDLP_COOKIES_FROM_BROWSER=chrome` in front of the command (or `firefox`, `safari`, `edge`, `brave`), which lets yt-dlp use the user's own YouTube sign-in from that browser, read on this machine and never sent to Clipy. |
| `unknown`, and `error` says "Private video" or "Video unavailable" | Ask for a public link to the video. |
| anything else | Tell the user the `error` first. Then run `clipy doctor` (or `clipy doctor --local` for a video file) and read it as described below. |

### Reading `clipy doctor`

`clipy doctor` checks the whole CLI, including features `/watch` does not use,
so it can end in failed checks that have nothing to do with this video.

- `FAIL auth` (`no API key configured`): expected without a Clipy account.
  Imports without `--sync` need no account. Do not suggest `clipy login` and do
  not present this as the cause.
- `FAIL api` (`clipy.online unreachable`): an import without `--sync` does not
  need clipy.online, so this does not explain its failure. It can be a sign
  that the network is restricted; the import's own `error` says which request
  failed.
- Bridge, Playwright, Chrome and screen checks are for recording. Ignore them.
- Report a `yt-dlp` or `ffmpeg` line (YouTube), or a `local ...` line (video
  file), when it is not `PASS` and relates to the `error`.

If no relevant line explains the failure, say that, and give the user the
import's `error`. A `PASS` on `yt-dlp` only means it is installed, not that it
can reach YouTube. If the `error` mentions a proxy or a failed connection, say
the network blocked the request and suggest a network that can reach the site.

Never retry the same failing command in a loop. Explain what happened in one
or two sentences and what the user can do next.
