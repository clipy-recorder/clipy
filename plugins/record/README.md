# Record: show Claude Code your screen

Some things are faster to show than to type. This plugin gives Claude Code a
`/record` command: it starts a Clipy screen recording on your Mac or Windows
PC, you talk
through what you want while you click around, you say **stop**, and Claude
reads the recording and gets to work.

<a href="https://clipy.online/video/jq4rktjwisp4"><img src="https://raw.githubusercontent.com/clipy-recorder/clipy/main/.github/assets/claude-setup-video.jpg" alt="Play the 90-second film: set up Clipy for Claude Code in one line, then show Claude your screen with /record or the Record with Clipy button"></a>

[Watch the 90-second setup film](https://clipy.online/video/jq4rktjwisp4): one command
sets up Clipy for Claude Code, then `/record` or the Record button does the rest.

```text
/plugin marketplace add clipy-recorder/clipy
/plugin install record@clipy
```

Then, in any Claude Code session on your Mac or PC:

```text
/record fix the bug I'm about to show you
```

Claude starts recording. Show it the problem and talk it through, then type
`stop`. Type `cancel` instead to throw the recording away.

The full name of the command is `/record:record`, if another plugin also has a
`/record`. You can also hand Claude a recording you already made in Clipy:
`/record <path to recording.arec>`.

## What you need

- A Mac or Windows PC with the [Clipy app](https://clipy.online/download),
  open and signed in. Clipy is free to start: 7-day free trial, no card needed. Or run Clipy
  Local, the open-source edition, with no account.
- Node.js 18.17 or later. The plugin runs the Clipy CLI (`@clipy/cli`) through
  `npx` if it is not installed.

The first time, Clipy asks whether AI agents may start recordings. Allow it
once and it remembers.

## How it works

```bash
clipy session start --local --source mac-screen --mic --max 600
clipy session stop --local
```

The Clipy app records your screen, your microphone and system audio, and keeps
the recording on your Mac. When you stop, it builds `recording.arec` next to
the video: the transcript with timestamps, the key moments (your clicks,
highlights and what you said about them) and a screenshot of each. Claude reads
that file and the screenshots.

AREC is the open format that makes a recording readable by AI agents, in plain
Markdown. Version 1.4 is stable; the spec is public domain (CC0) and the
validator is MIT. Read it at [arecformat.org](https://arecformat.org).

Recordings stop by themselves after 10 minutes unless you ask Claude for
longer (up to 29 minutes).

## Privacy

- The video and the screenshots stay on your computer, and on a Mac the audio
  does too. Nothing is uploaded unless you upload it yourself.
- On Windows, Clipy transcribes the audio on its servers: the audio is sent
  for transcription and deleted once the transcript is made; the video never
  leaves your PC.
- With the Clipy app, the transcript text, the names of what you clicked, a
  sample of your clicks, pointer movements and key presses, and the size of the
  recorded area go to Clipy to pick the key moments. With Clipy Local, nothing leaves your Mac.
- The normal Clipy recording indicator is visible the whole time, and only
  programs running as you on your Mac can ask Clipy to record.
- What the plugin downloads, and from where: when the Clipy CLI is not
  installed, `npx -y @clipy/cli@0.21.0` fetches that exact version from the
  npm registry. Nothing else is downloaded by the plugin.

## More

- The full guide, with one-command setup and troubleshooting: [clipy.online/docs/claude-code](https://clipy.online/docs/claude-code)
- Let your AI agents watch videos too: the `watch` plugin in this marketplace.
- The AREC format: [arecformat.org](https://arecformat.org)
- Something not working? Run `clipy doctor`.

License: Apache-2.0.
