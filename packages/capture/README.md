# @clipy/capture

`@clipy/capture` provides screen-capture utilities for Clipy. It uses platform-specific capture backends and FFmpeg to record screen video.

## Features

- Screen recording on macOS, Windows, and Linux.
- FFmpeg-based video capture.
- Optional microphone audio capture.
- Capture availability checks and source listing.
- Virtual display support where available.
- Capture results include the output path, duration, geometry, interactions, and warnings.

## Requirements

Install FFmpeg and ensure it is available on your system's `PATH`.

### macOS

Install FFmpeg:

```bash
brew install ffmpeg
```

Allow the terminal or application running Clipy to access Screen Recording and Microphone permissions when prompted. Restart the terminal or application after changing permissions.

### Windows

Install FFmpeg:

```powershell
winget install Gyan.FFmpeg
```

Ensure FFmpeg is available on your `PATH`. The package uses Windows capture backends, including Desktop Duplication and a GDI fallback.

### Linux

Install FFmpeg using your distribution's package manager. For Debian or Ubuntu:

```bash
sudo apt install ffmpeg
```

X11 is required for the X11 screen-capture backend. Wayland environments may have limitations depending on the available XWayland setup. Virtual display support may use Xvfb.

## API

The package exports these main functions:

- `checkCapture` — checks whether capture is available and reports problems or hints.
- `listSources` — lists available capture sources.
- `startCapture` — starts a screen-capture session.
- `startVirtualDisplay` — starts a virtual display where supported.

Additional lower-level utilities and types are also exported.
import {
  ```ts
  checkCapture,
  listSources,
  startCapture,
} from "@clipy/capture";

const check = await checkCapture();

if (!check.ok) {
  throw new Error(check.problems.join("\n"));
}

const sources = await listSources();
console.log("Available sources:", sources);

const session = await startCapture({
  outPath: "./capture.mp4",
  fps: 30,
  maxSeconds: 5,
});

await session.ended;
const result = await session.stop();

console.log("Saved recording:", result.path);
console.log("Duration:", result.durationMs, "ms");
```

## Platform support

| Platform | Capture backend | Notes |
| --- | --- | --- |
| macOS | FFmpeg AVFoundation | Screen Recording permission is required. |
| Windows | FFmpeg Desktop Duplication (`ddagrab`) with GDI (`gdigrab`) fallback | Microphone capture uses DirectShow when configured. |
| Linux | FFmpeg X11 capture (`x11grab`) | Requires a usable X display; Wayland support may be limited. |

Microphone capture uses platform-specific audio backends. Pointer and interaction information are collected using platform-specific utilities where supported.

## Capture output

Video output uses H.264 with `yuv420p` pixel format in fragmented MP4 format. Fragmented MP4 helps preserve usable output when recording is interrupted unexpectedly.

Capture results can include:

- Output file path
- Recording duration in milliseconds
- Interaction information
- Display geometry, when available
- Warnings encountered during capture

## Troubleshooting

### FFmpeg is not found

Install FFmpeg for your operating system and verify that it is available on your `PATH`.

### Screen capture is blocked on macOS

Enable Screen Recording permission for the terminal or application running Clipy, then restart it.

### Linux capture does not work

Verify that an X11 display is available and that FFmpeg supports the required capture backend. Wayland environments may require additional configuration.

### Microphone audio is missing

Check operating-system microphone permissions and verify that the required audio input device and backend are available.

## Development

This package is part of the Clipy repository. Refer to the repository's development instructions for installing dependencies, running checks, and building packages.
