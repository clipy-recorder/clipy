# @clipy/local-config

Configuration management for Clipy's local edition.

Manages settings defining which model provider (if any) reads transcripts for spoken cues, how recordings are transcribed, and where API keys are safely held.

## Overview

Settings are stored in a local JSON configuration file (`config.json`, mode `0600`). In addition, environment variables override file settings at runtime:

| Environment Variable | Overrides | Accepted Values |
|---|---|---|
| `CLIPY_MODEL_PROVIDER` | `model.preset` | `openrouter`, `openai`, `gemini`, `groq`, `ollama`, `lmstudio`, `custom` |
| `CLIPY_MODEL_BASE_URL` | `model.baseUrl` | `http://` or `https://` URL |
| `CLIPY_MODEL_API_KEY` | `model.apiKey` | Secret API key |
| `CLIPY_MODEL` | `model.model` | Model identifier string |
| `CLIPY_TRANSCRIBE` | `transcription.kind` | `none`, `local`, `openai`, `groq`, `openai-compatible`, `deepgram`, `assemblyai`, `elevenlabs`, `gemini` |
| `CLIPY_TRANSCRIBE_API_KEY` | `transcription.apiKey` | Secret API key |
| `CLIPY_TRANSCRIBE_MODEL` | `transcription.model` | Model identifier string |
| `CLIPY_TRANSCRIBE_BASE_URL` | `transcription.baseUrl` | Endpoint URL (OpenAI-compatible only) |
| `CLIPY_LOCAL_CONFIG` | Config path | Absolute or relative file path |

## Security & Isolation

- **Endpoint Binding:** An API key saved in the file is bound to its specific provider endpoint. Changing the provider or base URL drops the stored key to prevent unintended token leakage.
- **Error Redaction:** Error messages never print or log API keys or secrets.
- **Offline By Default:** Without a configured model provider, spoken moment planning defaults to rules-only (offline), and transcription defaults to on-device models.

## Usage

```typescript
import { loadConfig, saveConfig, resolveTranscription, resolveMoments } from "@clipy/local-config";

// Load configuration merging disk settings and environment overrides
const config = loadConfig();

// Resolve transcription provider and credentials
const transcription = resolveTranscription(config);

// Resolve LLM provider for spoken moments
const moments = resolveMoments(config);
```

## License

Apache-2.0
