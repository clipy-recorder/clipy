# Fully Offline Setup Guide

Clipy can run locally without sending recordings, transcripts, or model requests to hosted services. This guide explains how to prepare Clipy for offline use with local speech transcription and a locally hosted language model.

## 1. Understand the two local components

Clipy has two separate components that can run locally:

- **Local transcription:** Converts recorded audio into text using an on-device speech model.
- **Local language model (LLM):** Analyzes transcripts to identify spoken moments and context using a model running on your machine.

You can use local transcription without configuring an LLM. Without an LLM provider, Clipy uses its rules-only planner.

## 2. Prepare the required software and models

A first-time setup requires downloading the CLI, speech engine, transcription model, and (if used) local LLM software and model files.

Install the Clipy CLI:

```bash
npm install -g @clipy/cli
```

Download the English transcription model:

```bash
clipy models download english-fast
```

Install the local speech engine:

```bash
clipy speech install
```

The speech engine is approximately 35 MB. These downloads require network access. To use Clipy on a machine that will remain offline, prepare and verify all required software and model files before disconnecting it.

## 3. Configure local speech transcription

Clipy supports two local transcription models:

| Model | Description |
| --- | --- |
| `english-fast` | English transcription using Parakeet TDT CTC 110M int8 |
| `multilingual` | Multilingual transcription using Whisper base int8, supporting approximately 99 languages |

The default transcription model is `english-fast`.

To download the multilingual model instead:

```bash
clipy models download multilingual
```

To explicitly configure local transcription through environment variables:

```bash
export CLIPY_TRANSCRIBE=local
export CLIPY_TRANSCRIBE_MODEL=english-fast
```

On Windows PowerShell, use:

```powershell
$env:CLIPY_TRANSCRIBE = "local"
$env:CLIPY_TRANSCRIBE_MODEL = "english-fast"
```

These PowerShell environment variables apply only to the current terminal session. They are cleared when the session closes. Use the configuration file described below to save settings between sessions.

To disable transcription:

```powershell
$env:CLIPY_TRANSCRIBE = "none"
```

## 4. Configure a local language model

Clipy supports local model providers that expose an OpenAI-compatible chat completions API.

### Option A: Ollama

1. Install Ollama and download a model before going offline.
2. Start the Ollama service.
3. Configure Clipy to use Ollama.

On macOS/Linux:

```bash
export CLIPY_MODEL_PROVIDER=ollama
export CLIPY_MODEL=your-model-name
```

On Windows PowerShell:

```powershell
$env:CLIPY_MODEL_PROVIDER = "ollama"
$env:CLIPY_MODEL = "your-model-name"
```

Ollama's default API base URL is:

```text
http://127.0.0.1:11434/v1
```

### Option B: LM Studio

1. Install LM Studio and download a compatible model.
2. Load the model in LM Studio.
3. Start its local server.
4. Configure Clipy.

On Windows PowerShell:

```powershell
$env:CLIPY_MODEL_PROVIDER = "lmstudio"
$env:CLIPY_MODEL = "your-model-name"
```

LM Studio's default API base URL is:

```text
http://127.0.0.1:1234/v1
```

Both local providers use an OpenAI-compatible `/chat/completions` endpoint. They do not require an API key when configured as local providers.

## 5. Configure using config.json

Instead of setting environment variables every time, you can store settings in Clipy's configuration file.

Example configuration for local Ollama and local transcription:

```json
{
  "version": 1,
  "model": {
    "preset": "ollama",
    "model": "your-model-name"
  },
  "transcription": {
    "kind": "local",
    "model": "english-fast"
  }
}
```

The configuration file location depends on your operating system:

| Operating system | Default location |
| --- | --- |
| Windows | `%APPDATA%\clipy-local\config.json` |
| macOS | `~/Library/Application Support/clipy-local/config.json` |
| Linux | `$XDG_CONFIG_HOME/clipy-local/config.json` if `XDG_CONFIG_HOME` is set to an absolute path; otherwise `~/.config/clipy-local/config.json` |

You can override the configuration file location using `CLIPY_LOCAL_CONFIG`.

Environment variables override values stored in the configuration file.

## 6. Record locally

Once the software and models are prepared, record using:

```bash
clipy record --local --max 120
```

You can also import a video file:

```bash
clipy context import demo.mov --local
```

To inspect the current settings:

```bash
clipy local status
```

## 7. Privacy and network behavior

Clipy's local configuration is designed to keep processing on your machine.

| Configuration | Network behavior |
| --- | --- |
| No model provider + local transcription | No model-provider request; audio transcription stays local |
| Ollama or LM Studio + local transcription | Model and transcription processing run locally |
| Hosted LLM provider | Transcript text and relevant interaction context are sent to the configured provider |
| Hosted transcription provider | Audio is sent to the configured transcription provider |

Important points:

- Local transcription keeps audio on your machine.
- Ollama and LM Studio run the language model locally.
- With no model provider configured, Clipy uses rules-only planning.
- Telemetry is always disabled in this local edition.
- Initial software and model downloads require network access.
- Avoid hosted transcription and hosted LLM providers when offline operation is required.

## 8. Troubleshooting

### Speech model is missing

Download the selected model:

```bash
clipy models download english-fast
```

For multilingual transcription:

```bash
clipy models download multilingual
```

### Speech engine is missing

Install the speech engine:

```bash
clipy speech install
```

### Local LLM is not responding

Check that:

- Ollama or LM Studio is running.
- The selected model has been downloaded and loaded.
- The configured model name is correct.
- The local API server is listening on its expected address and port.

### Configuration is invalid

Check that:

- The configuration file contains valid JSON.
- The provider preset is supported.
- The model name is provided for Ollama and LM Studio.
- Custom provider URLs use HTTP or HTTPS.

## 9. Verify offline readiness

Before disconnecting from the internet:

1. Install the Clipy CLI.
2. Download the required transcription model.
3. Install the speech engine.
4. Download the local LLM model if using Ollama or LM Studio.
5. Configure Clipy to use only local providers.
6. Run `clipy local status` and verify the configuration.
7. Make a test recording while connected, then disconnect and repeat the test.

Initial installation and model downloads require an internet connection. Before going offline, download all required software, speech models, and local LLM models. Test the complete workflow while disconnected from the internet to verify that the required dependencies are available locally.