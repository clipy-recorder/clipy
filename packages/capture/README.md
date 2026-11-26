# @clipy/capture

Cross-platform screen and audio recording with FFmpeg, accompanied by a synchronized pointer and click interaction sidecar.

## Platform Support

- **macOS:**
  - Video: `avfoundation` display capture
  - Audio: `avfoundation` audio input
  - Sidecar: macOS JXA (`NSEvent.mouseLocation`)
- **Windows:**
  - Video: `ddagrab` (Desktop Duplication API) with `gdigrab` fallback
  - Audio: DirectShow (`dshow`) audio devices
  - Sidecar: DPI-aware PowerShell polling (`GetCursorPos`, `GetAsyncKeyState`)
- **Linux:**
  - Video: `x11grab` (entire displays or specific window IDs)
  - Audio: PulseAudio or ALSA
  - Sidecar: Python 3 with `ctypes` over `libX11` (`XQueryPointer`)
  - Virtual Displays: Isolated `Xvfb` display allocation via `startVirtualDisplay`

## Usage

```typescript
import { checkCapture, listSources, startCapture } from "@clipy/capture";

// Verify system prerequisites and ffmpeg availability
const check = await checkCapture();
if (!check.ok) {
  console.error("Capture prerequisites missing:", check.problems);
}

// List available screens and windows
const sources = await listSources();
console.log("Sources:", sources);

// Start recording display:0
const session = await startCapture({
  source: "display:0",
  outputPath: "recording.mp4",
  sidecarPath: "recording.cursor.json",
  fps: 30,
});

// Record for 5 seconds then stop
await new Promise((resolve) => setTimeout(resolve, 5000));
const result = await session.stop();
console.log(`Recorded ${result.durationMs}ms to ${result.videoPath}`);
```

## License

Apache-2.0
