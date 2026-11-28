# Watch: let your AI agent watch any video

Clipy is a free tool to connect your AI agents and let them watch videos.
This plugin gives Claude Code a `/watch` command: point it at a YouTube video,
a Loom link or a video file on your machine, ask a question, and Claude
answers with the timestamps that back it up.

```text
/plugin marketplace add clipy-recorder/clipy
/plugin install watch@clipy
```

Then, in any Claude Code session:

```text
/watch https://www.youtube.com/watch?v=<id> what are the three main steps?
/watch https://www.loom.com/share/<id> list every bug the speaker points out
/watch ./demo.mov summarize this
```

The full name of the command is `/watch:watch`, if another plugin also has a
`/watch`. You do not need the command at all: share a video link and ask, and
Claude reaches for the watch skill by itself.

## How it works

Under the hood the plugin runs the Clipy CLI (`@clipy/cli`). If you do not
have it installed, it runs through `npx`, so the only requirement is Node.js
18.17 or later.

```bash
clipy context import "https://www.youtube.com/watch?v=<id>"   # YouTube or Loom
clipy context import ./demo.mov --local                        # a file on your machine
```

Each import writes a folder and Claude reads `recording.arec` in it:

- A YouTube or Loom link gives a `clipy-context-<id>` folder in the current
  directory, with `recording.arec` (the same bytes as `recording.md`),
  `transcript.json` and `manifest.json`.
- A `--local` file import gives a folder under `~/clipy/recordings/` with
  `recording.arec`, a copy of the video, `transcript.json`, `moments.json` and
  a screenshot of each key moment in `frames/`.

AREC is the open format that makes a recording readable by AI agents: the
transcript, the key moments with a frame of each, and timestamps, in plain
Markdown. Version 1.4 is stable; the spec is public domain (CC0) and the
validator is MIT. Read it at [arecformat.org](https://arecformat.org).

For a video file, the first `--local` import needs an on-device speech model.
Claude asks before downloading it. It is a one-time setup:

```bash
clipy models download english-fast   # about 104 MB
clipy speech install                 # about 35 MB
```

## Privacy

- YouTube captions and Loom transcripts are fetched on your machine. No Clipy
  account and no login.
- `--local` transcribes on your machine with an on-device model. Nothing is
  uploaded to Clipy.
- `--sync` is optional and needs a Clipy account. It saves the transcript, the
  AREC document and the selected frames, never the video itself, to your
  private Clipy library. Clipy classifies the video and picks the moments worth
  a frame; the frames are extracted on your machine with ffmpeg and then
  uploaded. Your agents search the library through the Clipy MCP server. The
  plugin never adds `--sync` unless you ask for it.
- What the plugin downloads, and from where: when the Clipy CLI is not
  installed, `npx -y @clipy/cli@0.21.0` fetches that exact version from the
  npm registry. The first YouTube or Loom import fetches Clipy's own copy of
  yt-dlp from yt-dlp's GitHub releases into `~/.clipy/bin`. The first `--local`
  import asks before it downloads the speech model (GitHub or Hugging Face,
  from the sherpa-onnx project) and the engine that runs it.

## Codex, Cursor and other agents

The same workflow is a skill for other agents:

```bash
npm i -g @clipy/cli
clipy agents install codex     # or: cursor, claude
```

## Price

The plugin, the Clipy CLI, `--local` and this repository are free. The hosted
Clipy app, with share links anyone can watch and search across all your
recordings, is free to start with a 7-day free trial, no card.

## More

- Let your AI agents watch videos: [clipy.online/ai-watch-videos](https://clipy.online/ai-watch-videos)
- The AREC format: [arecformat.org](https://arecformat.org)
- Something not working? Run `clipy doctor`, or `clipy doctor --local` for a
  video file. Without the CLI installed, use `npx -y @clipy/cli@0.21.0` in place
  of `clipy`. The full `clipy doctor` also checks account and recording
  features: without a Clipy account it shows `FAIL auth` and suggests
  `clipy login`. `/watch` does not need that unless you use `--sync`.

License: Apache-2.0.
