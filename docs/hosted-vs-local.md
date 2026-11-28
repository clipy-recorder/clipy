# Hosted vs. Local: A Practical AREC Comparison

## Overview

This experiment compares Clipy's hosted and local recording workflows by reproducing the same real-world UI bug and evaluating whether their generated ARECs provide sufficient context for an AI coding agent to identify the issue.

Both recordings were created on Windows and evaluated using the same AI agent and prompt.

## Bug under test

- **Application:** [Campus Matrix](https://campusmatrix.onrender.com/)
- **Affected route:** `/auth/signup`
- **Affected page:** [Sign-up page](https://campusmatrix.onrender.com/auth/signup)
- **Bug:** Inconsistent dark-mode application on the sign-up page.

### Steps to reproduce

1. Open the Campus Matrix sign-up page.
2. Ensure the Light theme is active.
3. Open the theme selector in the navigation bar.
4. Select Dark mode.
5. Observe the navigation bar and sign-up form.

**Expected behaviour:** The entire page adapts to the dark theme while maintaining readable form labels and consistent styling.

**Actual behaviour:** The navigation bar changes colour, but the sign-up form does not adapt correctly. Form labels become difficult to read.

## 1. Hosted workflow

### Steps

1. Download the Clipy Windows application from [clipy.online/download](https://clipy.online/download).
2. Create a free trial account and sign in.
3. Start a screen recording with microphone narration.
4. Reproduce the bug while explaining the expected and actual behaviour.
5. Stop the recording and wait for hosted processing to complete.
6. Open the generated share link and its corresponding AREC link.

**Recording:** [Watch recording](https://clipy.online/video/tkwrnf8y23do)

**AREC:** [Hosted agent context](https://clipy.online/video/tkwrnf8y23do.arec)

### Retrieving the AREC

```powershell
cd "$env:USERPROFILE\Downloads"

curl.exe -L -H "Accept: text/markdown" "https://clipy.online/video/tkwrnf8y23do.arec" -o hosted.arec
```

### Observed timings

- Time to first AREC: approximately 7 minutes, from initial setup to a usable AREC.
- Recording duration: approximately 74 seconds.
- Post-recording processing: approximately 1 minute.

These timings are estimates rather than instrumented benchmarks.

## 2. Local workflow

### Prerequisites

- Node.js 20.19 or later
- FFmpeg
- Chrome or another compatible browser

### Installation

```powershell
npm i -g @clipy/cli
clipy models download english-fast
clipy speech install
```

Clipy CLI version used: `0.21.0`.

### Native recording attempt

The following command was attempted:

```powershell
clipy record --local --mic --max 120
```

However, FFmpeg stopped before recording began with the following error:

```text
Option thread_queue_size cannot be applied to input url desktop.
Error parsing options for input file desktop.
Error opening input files: Invalid argument
```

The exact cause was not investigated further.

### Alternative recording method

[Screen Recorder](https://screen-recorder.com/), a browser-based screen recorder using screen sharing, was used as an alternative capture method.

1. Open [screen-recorder.com](https://screen-recorder.com/).
2. Start a screen recording with microphone narration.
3. Reproduce the same Campus Matrix bug using the steps described above.
4. Stop the recording and save the video as `campus-matrix-bug.mp4`.
5. Open a terminal in the directory containing the downloaded video.
6. Import the recording using Clipy's local import workflow:

```powershell
clipy context import campus-matrix-bug.mp4 --local
```

The CLI successfully generated an AREC and reported:

```text
Done: 3 screenshots, 15 transcript segments.
Nothing was uploaded.
```

The generated AREC and its associated assets were stored in the local Clipy recordings directory.

### Observed timings

- Time to first AREC: approximately 7–9 minutes, based on an adjusted estimate.
- Recording duration: 73.418 seconds, according to AREC metadata.
- Import processing time: not measured separately.

The local timing includes setup and troubleshooting, but was adjusted to account for time spent on external recording. Therefore, it is not directly comparable to the hosted timing.

These estimates should not be used to draw conclusions about the relative processing speed of the two workflows.

## 3. Evidence comparison

The references in the following table correspond to section headings in the respective AREC documents. Both ARECs are provided as supporting evidence with the pull request.

| Evidence | Hosted | Local |
|---|---|---|
| AREC specification | 1.4 (`Metadata`) | 1.4 (`Metadata`) |
| Transcript | 23 timestamped entries (`Transcript`) | 15 timestamped segments (`Transcript`) |
| Generated summary | Present (`Summary`) | Absent (`Summary`) |
| Intent classification | Classified as a bug report (`Intent`) | Not classified (`Intent`) |
| Selected key moments | 17 indexed moments (`Key moments`) | No selected moments; three overview samples (`Key moments`) |
| Screenshots | 16 linked frames (`Key moments`) | Three evenly spaced frames (`Key moments`) |
| Cropped screenshots | 16 linked detail crops (`Key moments`) | No crops listed (`Key moments`) |
| Cursor telemetry | Present, including normalized coordinates (`Interaction timeline`) | Not captured (`Interactions`) |
| Click data | 15 reported click events (`Interaction timeline`) | Not captured (`Interactions`) |
| Pointer dwell data | 12 derived dwell events (`Interaction timeline`) | Not captured (`Interactions`) |
| Navigation data | Not captured (`Capture gaps`) | No interaction sidecar (`Capture gaps`) |
| Browser diagnostics | Not captured (`Capture gaps`) | Not captured (`Capture gaps`) |
| Fix checklist | Present (`Fix checklist`) | Not provided (`Summary`, `Intent`) |
| Implementation plan | Present (`Suggested implementation plan`) | Not provided (`Summary`, `Intent`) |
| Access | Public hosted URL (`Metadata`) | Local file with relative asset paths (`Metadata`, `How to use this recording`) |
| Data leaving the machine | Video, transcript, screenshots, generated summary and interaction evidence available through hosted links (`Metadata`, `Transcript`, `Summary`, `Interaction timeline`, `Key moments`) | No upload reported during Clipy processing (`Evidence boundaries`) |

### Evidence limitations

The hosted recording contains substantially richer structured context, including interaction events, selected moments and cropped screenshots.

However, the local recording was imported from an external screen recorder without an interaction sidecar or a configured model provider. Its missing interaction evidence should not be interpreted as a limitation of every local Clipy recording workflow.

Both recordings contain transcription errors. The local transcript appears more coherent in this example, although transcription accuracy was not formally measured against the original audio.

The comparison reflects the specific capture and processing configurations used in this experiment rather than the full capabilities of either workflow.

## 4. AI agent evaluation

Both ARECs were evaluated using ChatGPT GPT-5.6 Terra Codex, with access to their associated visual evidence.

The same prompt was used for both recordings:

> what is the bug and where does it happen?

### Hosted response

> The dark-mode toggle only updates the navigation bar, not the sign-up form.
>
> It happens on the `/sign-up` page immediately after selecting Dark Mode (around 0:12). The form’s text/fields retain incompatible light-theme styling and become unreadable—clearly shown around 0:24 and 0:53.

### Local response

> The bug is a broken dark-theme implementation on the **Campus Matrix Sign up page**.
>
> At **00:00:39.760**, selecting **Dark** changes the navbar to dark, but the sign-up form stays light. Its field labels become effectively invisible (light/white text on the white form), making the form unreadable.
>
> Location: **top navigation theme selector → Sign up page form**.

### Evaluation

| Criterion | Hosted | Local |
|---|---|---|
| Correct bug identification | Yes | Yes |
| Correct affected page | Yes | Yes |
| Correct triggering action | Yes | Yes |
| Correct visual symptom | Yes | Yes |
| Timestamp references | Present | Present |
| Exact route | Incorrect (`/sign-up`) | Not specified |
| Application name | Not specified | Campus Matrix |

Both responses correctly identified the primary bug.

The hosted response provided multiple timestamps but incorrectly stated the exact route. The local response identified the application and described the apparent contrast problem more specifically.

Neither response established the code-level root cause, which was outside the scope of the prompt.

Although both agents had access to visual evidence, actual image inspection was not independently verified.

## 5. Privacy and data handling

### Hosted workflow

The hosted workflow uploaded the recording for hosted processing and generated a publicly accessible share link and AREC.

The resulting hosted evidence included:

- Video and timestamped transcript.
- Generated summary and intent classification.
- Screenshots and cropped detail images.
- Cursor, click and pointer dwell evidence.
- Generated fix checklist and implementation plan.

These observations establish what was available remotely, rather than an exhaustive account of network transmissions.

### Local workflow

The local CLI reported that no recording data was uploaded during local processing. The AREC's `Evidence boundaries` section also states that video, audio, screenshots and interaction evidence remain on the machine.

This was not independently verified through network monitoring.

The external screen recorder's data handling was not independently verified. The local privacy observations therefore apply specifically to Clipy's local import and processing stage, rather than the entire recording workflow.

Local Clipy processing should also be distinguished from the subsequent AI agent evaluation. Providing local recording evidence to a cloud-based AI agent may transmit that evidence to the AI provider.

## 6. Which one should I use?

**Use hosted when:**

- You want a shareable recording link.
- You need richer structured context for an AI agent.
- You want generated summaries, selected moments and interaction evidence similar to those observed in this experiment.

**Use local when:**

- You want to avoid uploading recordings to Clipy.
- You need to retain control over recording files.
- A transcript and screenshots provide sufficient context for the task.

For this particular bug, both workflows provided enough evidence for successful identification. The additional hosted context did not produce a substantially more accurate diagnosis.

However, this experiment covers only one bug and two specific capture configurations. It does not establish that either workflow is universally superior.