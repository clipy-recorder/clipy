# `@clipy/transcribe`

Transcribes the speech from a video or audio file into timestamped transcript segments.

## Transcription kinds

The `transcribe()` function accepts a `TranscriptionConfig` with one of these kinds:

| Kind | Description |
|---|---|
| `none` | Transcription is disabled. No audio is sent anywhere. The result contains a gap covering the whole file. |
| `local` | Uses a downloaded speech model and runs transcription on the local machine. Audio does not leave the machine. |
| `openai-compatible` | Sends audio to an OpenAI-compatible transcription endpoint using the configured API key. |
| `deepgram` | Sends audio to Deepgram using the configured API key. |
| `assemblyai` | Sends audio to AssemblyAI using the configured API key. |
| `elevenlabs` | Sends audio to ElevenLabs using the configured API key. |
| `gemini` | Sends audio to Gemini using the configured API key. |

For hosted providers, `baseUrl` is optional and can be used for a regional endpoint, proxy, or test server. The `openai-compatible` configuration requires a `baseUrl`, `apiKey`, and `model`. The other hosted providers accept an API key and may optionally accept a model and base URL.

## Local models

Two local speech models are available:

### `english-fast`

**English, fast (Parakeet TDT-CTC 110M)**

- English-only.
- NVIDIA Parakeet TDT-CTC 110M.
- Converted to ONNX int8 by the sherpa-onnx project.
- Download size: about 104 MB.
- License: CC-BY-4.0.

### `multilingual`

**All languages (Whisper base)**

- Multilingual Whisper Base model.
- Supports about 99 languages.
- Converted to ONNX int8 by the sherpa-onnx project.
- Download size: about 161 MB.
- License: MIT.

## Downloading and checking local models

Models are not downloaded automatically by this package. The application or CLI calls `downloadModel()` after the user agrees.

`downloadModel(model)`:

- Downloads the selected model.
- Verifies downloaded files using their pinned SHA-256 checksums.
- Stages the model in a temporary directory.
- Installs it only after all required files have been verified.
- If the download fails or is cancelled, the incomplete staging directory is removed.
- If the model is already installed, it returns the existing model directory.

`modelStatus(model)` checks whether a model is installed and returns:

```ts
{
  installed: boolean;
  dir: string;
}
```

The default model cache location is:

- Linux: `~/.cache/clipy-local/models`
- macOS: `~/Library/Caches/clipy-local/models`
- Windows: `%LOCALAPPDATA%\clipy-local\models`

A custom model directory can also be supplied.

## Gaps

A transcription result contains both `segments` and `gaps`.

A **gap** represents a part of the recording for which there is no transcript.

Each gap contains:

```ts
{
  startMs: number;
  endMs: number;
  reason: string;
}
```

For example, when transcription is disabled with `kind: "none"`, the whole recording is returned as a gap with the reason `transcription off`.

If a file has no audio track, the whole recording is returned as a gap with the reason `no audio track`.

## FFmpeg requirement

FFmpeg is required for media probing and audio extraction.

The package converts the input audio to:

- 16 kHz
- mono
- 16-bit PCM WAV

By default, the package runs `ffmpeg` from the system `PATH`.

To use a specific FFmpeg executable, set the `CLIPY_FFMPEG` environment variable:

```bash
CLIPY_FFMPEG=/path/to/ffmpeg
```

On Windows, for example:

```powershell
$env:CLIPY_FFMPEG="C:\path\to\ffmpeg.exe"
```

If FFmpeg cannot be found, transcription fails with an error explaining that FFmpeg must be installed or `CLIPY_FFMPEG` must be set.

## Data and privacy

There are two different transcription paths:

### Stays on the machine

These kinds do not send audio to a hosted transcription provider:

- `none`
- `local`

`local` uses a downloaded speech model on the user's machine.

### Sends audio to a provider

These kinds send audio to their configured transcription provider:

- `openai-compatible`
- `deepgram`
- `assemblyai`
- `elevenlabs`
- `gemini`

Hosted providers use the user's configured API key.

The package documentation in `index.ts` also specifies that it does not log API keys, response bodies, or transcript text.
