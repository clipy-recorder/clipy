# Record with Clipy: a Record button inside Claude Code

Some things are faster to show than to type. This plugin puts a **Record with
Clipy** button above the prompt in Claude Code. Press it, show Claude what you
mean while you talk it through, press **Stop and send**, and Claude reads the
recording and gets to work.

<a href="https://clipy.online/video/jq4rktjwisp4"><img src="https://raw.githubusercontent.com/clipy-recorder/clipy/main/.github/assets/claude-setup-video.jpg" alt="Play the 90-second film: set up Clipy for Claude Code in one line, then show Claude your screen with /record or the Record with Clipy button"></a>

[Watch the 90-second setup film](https://clipy.online/video/jq4rktjwisp4): one command
sets up Clipy for Claude Code, then `/record` or the Record button does the rest.

No prompt to write, no screenshots to paste. Claude gets what you said, when
you said it, what you clicked and a screenshot of each moment that matters.

## Install

In Claude Code (2.1.328 or later):

```text
/plugin install clipy-record --marketplace clipy-recorder/clipy
```

Or add the marketplace first, which also gives you `/record` and `/watch`:

```text
/plugin marketplace add clipy-recorder/clipy
/plugin install clipy-record@clipy
```

The button then sits above the prompt in every Claude Code session on your Mac
or Windows PC: in the terminal, the desktop app and VS Code. Cloud sessions get
it too; see [Local or Cloud](#local-or-cloud).

## You also need Clipy on your computer

Pick one:

- **The Clipy app** for Mac or Windows:
  [download it](https://clipy.online/download?utm_source=github&utm_medium=readme&utm_campaign=record-plugin)
  and sign in once. Clipy is free to start: 7-day free trial, no card needed.
- **Clipy Local**, the open-source edition in this repository: build it
  yourself and record with no account at all.
  [How to run Clipy Local](https://clipy.online/docs/clipy-local).

And the Clipy CLI, which the button drives:

```bash
npm i -g @clipy/cli
```

It needs version 0.20.0 or later. Without it installed, the button runs it
through `npx`.

The first time, Clipy asks whether AI agents may start recordings. Allow it
once and it remembers.

## Using it

- **● Record with Clipy** starts recording your screen and microphone. The
  band shows a timer while it records.
- **Stop and send** stops, and Clipy builds the recording on your computer.
  It then reaches Claude as your next prompt.
- **Cancel** throws the recording away. Claude never sees it.
- Stopping from the Clipy app works too: the band notices and sends the
  recording to Claude the same way.
- **Hide** tucks the button away in every session. Run `/record-button` to
  bring it back.
- With the band focused (ctrl+x tab, or a click), `r` records, `s` stops and
  sends, `c` cancels and `h` hides.

## Local or Cloud

**Switch to Cloud** / **Switch to Local** on the band chooses where the
recording goes, and the line beside the button says which one is on. Your
choice is kept for next time; Local is the default.

- **Local**: the button records through the Clipy app and the recording stays
  on your computer. Claude reads the file.
- **Cloud** (Record with Clipy is the highlighted button): the Clipy app
  records and uploads it, and Claude gets the share link.

With more than one screen, the button records the screen Claude Code is on
(the Claude app, your terminal or your editor), not the primary one. Clipy needs to be signed in on this computer
  (`clipy login`).

When Claude Code itself runs in a cloud session, it can't see your screen, so
the band switches to Cloud by itself. Press **Record with Clipy**, then record
with Clipy on your computer (the app, the Chrome extension or clipy.online).
The band watches your Clipy library and sends the new recording's link to
Claude once its transcript and summary are ready. **Send now** sends it
straight away; **Cancel** stops waiting.

The first time, a cloud session asks you to **Sign in to Clipy**. Open the
sign-in page, check that it shows the same code as the band, and approve: the
band signs itself in a few seconds later, or you can paste the code the page
gives you. The key it gets can only read your recordings, and it is kept for
later sessions on that machine. To use a key of your own instead, set
`CLIPY_API_KEY` in the cloud environment (create one at
[clipy.online/settings/api-keys](https://clipy.online/settings/api-keys)); it
takes priority. The environment's network access must allow `clipy.online`.

When something goes wrong, the band says what and what to do: Clipy not open,
Clipy quitting during a recording, a key Clipy refuses, or a recording that
could not be handed to Claude (the band then shows where it is, to paste).

Recordings stop by themselves after 10 minutes. Change that, or point the
button at a CLI that is not on your PATH, in `/config` under Record with Clipy.

## What Claude gets

Every recording becomes an AREC file next to the video: the transcript with
timestamps, the key moments (your clicks, highlights and what you said about
them) and a screenshot of each. Claude reads that file and the screenshots,
then does what you asked.

AREC is the open format that makes a recording readable by AI agents, in plain
Markdown. Version 1.4 is stable; the spec is public domain (CC0) and the
validator is MIT. Read it at [arecformat.org](https://arecformat.org).

## Privacy

- On Local, the video and the screenshots stay on your computer. Nothing is
  uploaded unless you switch to Cloud or upload it yourself.
- On Cloud, the Clipy app uploads the recording to your Clipy library.
- In a cloud session the band only reads your newest recording, with a key
  that can read recordings and nothing else; it records nothing itself.
- With the Clipy app, the transcript text, the names of what you clicked, a
  sample of your pointer and key activity and the size of the recorded area go
  to Clipy to pick the key moments. On Windows the audio also goes to Clipy for
  the transcript and is deleted once it is done.
- With Clipy Local, nothing leaves your computer unless you add a model
  provider yourself.
- The normal Clipy recording indicator is visible the whole time.
- What the plugin downloads, and from where: when the Clipy CLI is not
  installed, `npx -y @clipy/cli@0.21.0` fetches that exact version from the
  npm registry. Nothing else is downloaded by the plugin.

## Open source

Apache-2.0, like the rest of this repository. The button is
[hooks/register.tsx](hooks/register.tsx) and, for cloud sessions,
[hooks/cloud.ts](hooks/cloud.ts) and [hooks/signin.ts](hooks/signin.ts), with its tests in
[hooks/register.test.tsx](hooks/register.test.tsx). To try a change, clone the
repository and run:

```bash
claude plugin test plugins/clipy-record
claude --plugin-dir plugins/clipy-record
```

## More

- The full guide, with one-command setup and troubleshooting:
  [clipy.online/docs/claude-code](https://clipy.online/docs/claude-code).
- Prefer typing? `/record` in the same marketplace does this from a command:
  [plugins/record](../record/README.md).
- Let Claude watch any video, a YouTube link, a Loom link or a file:
  [plugins/watch](../watch/README.md).
- Something not working? Run `clipy doctor`, or
  [open an issue](https://github.com/clipy-recorder/clipy/issues/new?template=app_bug_report.yml).
