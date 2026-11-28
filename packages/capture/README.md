# @clipy/capture

`@clipy/capture` is a screen-recording package that uses FFmpeg to capture displays across macOS, Windows, and Linux. It also collects pointer movement and click information where supported by the operating system.

It supports display selection, Linux window capture, optional microphone recording, and virtual displays on Linux.

## Features

- Cross-platform screen recording.
- Display enumeration and selection.
- Linux window capture.
- Optional microphone recording.
- Pointer movement and click tracking where supported.
- H.264 video encoding.
- Fragmented MP4 output to preserve playable recordings after interruptions.
- Linux virtual display support through Xvfb.

## Requirements

- Node.js 20.19 or newer.
- pnpm.
- FFmpeg installed and available on `PATH`.
- An FFmpeg build with the required screen-capture backend and an H.264 encoder.

The CI environment uses Node.js 24.

### Operating system requirements

| Operating system | Capture backend | Additional requirements |
|---|---|---|
| Linux | `x11grab` | X11 display and FFmpeg with x11grab support |
| macOS | `avfoundation` | Screen Recording permission |
| Windows | `ddagrab`, falling back to `gdigrab` | FFmpeg with the required capture backend |

Additional platform details:

**Linux**
- An active X11 display is required for normal screen capture.
- The `DISPLAY` environment variable identifies the display.
- PulseAudio or ALSA can be used for microphone recording.
- Python 3 and libX11 are used for pointer tracking.
- Xvfb is required for virtual displays.
- X11 utilities can improve display and window information.

**macOS**
- FFmpeg uses AVFoundation for screen and microphone capture.
- Grant Screen Recording permission to the terminal application running Node.js.
- Microphone permission is also required when recording audio.
- Restart the terminal after changing permissions.

**Windows**
- FFmpeg uses Desktop Duplication through `ddagrab`.
- If `ddagrab` cannot start, the package falls back to `gdigrab`.
- DirectShow (`dshow`) is used for microphone input.
- PowerShell is used for screen and pointer information.

## Installation

Install the repository dependencies:

```bash
pnpm install
```

Install FFmpeg and ensure it is available through your system's `PATH`.

For Debian or Ubuntu:

```bash
sudo apt install ffmpeg
```

For Fedora:

```bash
sudo dnf install ffmpeg
```

For macOS:

```bash
brew install ffmpeg
```

For Windows, install FFmpeg 6 or newer and ensure `ffmpeg.exe` is available on `PATH`.

## API Reference

### 1. checkCapture()

Checks whether the current system has the required FFmpeg configuration for screen recording.

**Syntax**

```ts
checkCapture(platform?: Platform): Promise<CaptureCheck>
```

The optional platform can be:

- `darwin` – macOS
- `win32` – Windows
- `linux` – Linux

**Example**

```ts
import { checkCapture } from "@clipy/capture";

const result = await checkCapture();

console.log(result.ok);
console.log(result.ffmpeg);
console.log(result.problems);
console.log(result.hints);
```

**Return value**

`CaptureCheck` contains:

- `ok`: Whether the basic capture requirements are satisfied.
- `ffmpeg`: The FFmpeg executable path, or `null` if not found.
- `problems`: Detected configuration problems.
- `hints`: Suggestions for resolving problems.

### 2. listSources()

Lists available displays and supported windows that can be recorded.

**Syntax**

```ts
listSources(
  platform?: Platform,
  opts?: { xDisplay?: string }
): Promise<CaptureSource[]>
```

On Linux, `xDisplay` can specify an X11 display other than the default `$DISPLAY`.

**Example**

```ts
import { listSources } from "@clipy/capture";

const sources = await listSources();

console.log(sources);
```

**Return value**

Each `CaptureSource` contains:

- `id`: Unique source identifier.
- `kind`: Either `display` or `window`.
- `name`: Human-readable source name.
- `width`: Optional source width.
- `height`: Optional source height.

Example output:

```json
[
  {
    "id": "display:0",
    "kind": "display",
    "name": "Display 1",
    "width": 1920,
    "height": 1080
  }
]

```
Source identifiers use the following formats:

- `display:0` – First display.
- `display:1` – Second display.
- `window:0x1a00003` – Linux window identifier.

Window capture is supported on Linux. macOS and Windows capture complete displays.

### 3. startCapture()

Starts a screen-recording session using FFmpeg.

**Syntax**

```ts
startCapture(options: CaptureOptions): Promise<CaptureSession>
```

**CaptureOptions**

| Option | Type | Description |
|---|---|---|
| `source` | `string` | Display or window identifier. Defaults to the main display. |
| `outPath` | `string` | Output MP4 file path. Required. |
| `fps` | `number` | Frames per second. Defaults to 30. |
| `maxSeconds` | `number` | Optional automatic recording duration limit. |
| `microphone` | `boolean \| string` | Enables microphone recording or selects a device. |
| `xDisplay` | `string` | Linux X11 display. Defaults to `$DISPLAY`. |

**Example**

```ts
import { startCapture } from "@clipy/capture";

const session = await startCapture({
  outPath: "./recordings/screen.mp4",
  fps: 30,
  maxSeconds: 60,
  microphone: false
});

// Stop recording and collect the result.
const result = await session.stop();

console.log(result.path);
console.log(result.durationMs);
console.log(result.interactions);
console.log(result.geometry);
console.log(result.warnings);
```

**CaptureSession**

The returned session provides:

- `startedAt`: Recording start time in epoch milliseconds.
- `ended`: Promise that resolves when FFmpeg exits.
- `stop()`: Stops recording and returns the capture result.
- `abort()`: Aborts recording and removes the output file.

**CaptureResult**

The result contains:

- `path`: Recorded video file path.
- `durationMs`: Recording duration in milliseconds.
- `interactions`: Pointer and interaction events.
- `geometry`: Captured screen geometry, or `null`.
- `warnings`: Recording warnings.

### 4. startVirtualDisplay()

Creates a private virtual display using Xvfb.

This functionality is available only on Linux.

**Syntax**

```ts
startVirtualDisplay(opts?: {
  width?: number;
  height?: number;
}): Promise<VirtualDisplay>
```

The default resolution is 1280 × 720.

Supported dimensions range from 320 × 240 to 7680 × 4320.

**Example**

```ts
import { startVirtualDisplay } from "@clipy/capture";

const display = await startVirtualDisplay({
  width: 1280,
  height: 720
});

try {
  console.log("Virtual display:", display.display);

  const env = display.env();

  console.log(env.DISPLAY);

  // Launch applications using this environment.
} finally {
  await display.stop();
}
```

**VirtualDisplay properties**

- `display`: X11 display name.
- `pid`: Xvfb process ID.
- `xauthority`: Xauthority file path, or `null`.
- `warnings`: Additional security or configuration warnings.
- `env()`: Creates an environment containing the virtual display settings.
- `stop()`: Stops Xvfb and cleans up its authentication file.

Install Xvfb on Debian or Ubuntu:

```bash
sudo apt install xvfb
```

For Fedora:

```bash
sudo dnf install xorg-x11-server-Xvfb
```

Installing `xauth` is recommended to enable access control for the virtual display.

## Video Output Format

The package produces:

- Container: MP4.
- Video codec: H.264.
- Pixel format: `yuv420p`.
- Encoding: Platform-supported H.264 encoder.
- Output: Fragmented MP4.

Fragmented MP4 helps preserve a playable recording if FFmpeg is interrupted unexpectedly.

The package also collects pointer and interaction information where the operating system supports it. These events are returned through the `interactions` property of `CaptureResult`.

## Additional Exports

The package also exports:

**Process management**

- `stopAllChildren()`: Signals tracked child processes to stop.

**FFmpeg utilities**

- `buildFfmpegArgs`
- `pickH264Encoder`
- `videoFilter`

**Pointer and interaction utilities**

- `samplesToEvents`
- `parseSampleLine`

**Exported TypeScript types**

- `Platform`
- `CaptureCheck`
- `CaptureGeometry`
- `CaptureOptions`
- `CaptureResult`
- `CaptureSession`
- `CaptureSource`
- `InteractionEvent`
- `VirtualDisplay`
- `CapturePlan`
- `VideoInput`
- `AudioInput`
- `PointerSample`

## Notes

- FFmpeg must be installed and accessible through `PATH`.
- Screen Recording permission is required on macOS.
- Normal Linux screen capture requires an X11 display.
- Native Wayland applications are not captured by the X11 backend.
- Virtual display creation requires Linux and Xvfb.
- Always call `stop()` when you want to finalize and collect a recording.
- Use `abort()` when you want to discard a recording.
- Use `stopAllChildren()` when an application needs to clean up tracked child processes before exiting.

## License

Apache-2.0