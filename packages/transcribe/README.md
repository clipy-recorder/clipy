# @clipy/transcribe

Transcribe audio and video recordings into timestamped transcript segments using local speech recognition or hosted transcription providers.

## Features

- Supports audio and video files.
- Local transcription using downloaded speech recognition models.
- Hosted transcription through OpenAI-compatible APIs, Deepgram, AssemblyAI, ElevenLabs, and Gemini.
- Automatic audio extraction and conversion using FFmpeg.
- Silence detection and audio chunking for long recordings.
- Timestamped transcript segments.
- Reports gaps where speech could not be transcribed.
- Supports cancellation and transcription progress callbacks.
- Automatically cleans up temporary audio files.

## Requirements

- Node.js
- FFmpeg installed and available in your system PATH.

To use a specific FFmpeg executable, set the `CLIPY_FFMPEG` environment variable to its full path.

```bash
export CLIPY_FFMPEG=/path/to/ffmpeg
```

No separate FFprobe installation is required.

## Transcription Engines

The package supports the following configurations:

| Engine              | Description                                         |
| ------------------- | --------------------------------------------------- |
| `none`              | Disables transcription.                             |
| `local`             | Runs a downloaded speech recognition model locally. |
| `openai-compatible` | Uses an OpenAI-compatible transcription API.        |
| `deepgram`          | Uses Deepgram transcription services.               |
| `assemblyai`        | Uses AssemblyAI transcription services.             |
| `elevenlabs`        | Uses ElevenLabs transcription services.             |
| `gemini`            | Uses Google's Gemini API.                           |

## Local Models

Two local models are supported:

| Model ID       | Description                                         |
| -------------- | --------------------------------------------------- |
| `english-fast` | Parakeet model optimized for English transcription. |
| `multilingual` | Whisper Base model for multilingual transcription.  |

Models can be downloaded and managed using the exported model utilities:

- `downloadModel()`
- `modelStatus()`
- `defaultModelDir()`
- `LOCAL_MODELS`

Local transcription processes audio on the user's machine. The audio is not sent to an external transcription provider.

If the required model is not installed, the package throws `ModelNotInstalledError`.

## Usage

```typescript
import { transcribe } from "@clipy/transcribe";

const result = await transcribe("recording.mp4", {
  kind: "deepgram",
  apiKey: process.env.DEEPGRAM_API_KEY!,
});

console.log(result.segments);
console.log(result.engine);
console.log(result.gaps);
```

### OpenAI-Compatible Provider

```typescript
const result = await transcribe("recording.mp3", {
  kind: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  model: "whisper-1",
});
```

### Local Transcription

```typescript
const result = await transcribe("recording.mp4", {
  kind: "local",
  model: "english-fast",
});
```

The required local model must be downloaded before transcription.

### Disable Transcription

```typescript
const result = await transcribe("recording.mp4", {
  kind: "none",
});
```

This returns an empty transcript and reports the recording duration as a gap.

## Result Format

The `transcribe()` function returns a `TranscribeResult`.

```typescript
interface TranscribeResult {
  segments: TranscriptSegment[];
  engine: string;
  language?: string;
  gaps: TranscriptGap[];
}
```

### Transcript Segment

Each segment represents a spoken portion of the recording.

```typescript
interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}
```

Timestamps are measured in milliseconds from the beginning of the recording.

### Transcript Gap

Gaps represent portions of the recording without an available transcript.

```typescript
interface TranscriptGap {
  startMs: number;
  endMs: number;
  reason: string;
}
```

Possible reasons include transcription being disabled, no audio track being present, or no speech being detected.

## Progress Tracking

The package supports progress callbacks through `TranscribeOptions`.

```typescript
const result = await transcribe(
  "recording.mp4",
  {
    kind: "deepgram",
    apiKey: process.env.DEEPGRAM_API_KEY!,
  },
  {
    onProgress: ({ stage, fraction }) => {
      console.log(stage, fraction);
    },
  },
);
```

Progress stages include:

- `extract`: Extracting audio from the input file.
- `download`: Downloading a local model.
- `transcribe`: Processing audio through the selected engine.

An `AbortSignal` can also be passed to cancel transcription.

## Error Handling

The package exports the following error classes:

- `NoAudioTrackError`: Thrown when the input file does not contain an audio track during audio extraction.
- `ModelNotInstalledError`: Thrown when a required local model is unavailable.
- `ChecksumError`: Indicates a downloaded model failed checksum verification.
- `DownloadTooLargeError`: Indicates a model download exceeded its allowed size.
- `ProviderError`: Represents hosted provider request failures.

Provider errors include the provider name and HTTP status where available. API keys, response bodies, and transcript content are not included in error messages.

## Privacy

- `none`: Does not perform transcription.
- `local`: Processes audio locally without sending it to an external service.
- Hosted providers: Send audio to the selected provider using the user's API key.

Temporary audio files are stored in a temporary directory and automatically removed after transcription, including when an error occurs.

## Exports

The package exports:

- `transcribe`
- `extractAudio`
- `NoAudioTrackError`
- `downloadModel`
- `modelStatus`
- `defaultModelDir`
- `LOCAL_MODELS`
- `ProviderError`
- `ModelNotInstalledError`
- Transcription-related TypeScript types.
