# @clipy/local-config

Local settings management for Clipy Local (`packages/config`). It resolves which model provider (if any) reads transcripts for spoken cues and how recordings are transcribed, combining a persisted JSON configuration file with environment variable overrides.

> **Note:** This is an internal workspace package (`"private": true`) and is not published to npm.

## Usage

Use `loadConfig` (which reads and resolves settings from disk and environment variables) and `saveConfig` (which atomically updates top-level fields in the JSON file with `0600` permissions without writing environment overrides):

```ts
import { configPath, loadConfig, saveConfig } from "@clipy/local-config";

// Check where the config file is stored on the current platform
const path = configPath();

// Save provider and transcription settings to disk
saveConfig({
  model: { preset: "openai", apiKey: "sk-...", model: "gpt-4.1-mini" },
  transcription: { kind: "local", model: "english-fast" },
});

// Load resolved settings (merges saved JSON with env var overrides)
const config = loadConfig();
// Default when no file exists:
// {
//   model: null,
//   modelPreset: null,
//   transcription: { kind: "local", model: "english-fast" },
//   telemetry: false,
// }

// Clear a saved model provider while keeping other fields intact
saveConfig({ model: null });
```

### Security & Resolution Guarantees
- **Key isolation:** A saved API key is only ever sent to the endpoint it was saved for. Switching providers via an environment variable drops the saved key and model; changing only the base URL drops the saved key while keeping the model name.
- **No secret leaks:** Nothing in this package logs or prints to stdout/stderr, and `ConfigError` messages never quote file contents or API keys.
- **Telemetry:** Always `false` in the local edition, regardless of what is written in the config file.

## Environment Variables

Settings come from the JSON file at `configPath()`, and non-empty environment variables override the file:

| Env var | Overrides |
|---|---|
| `CLIPY_MODEL_PROVIDER` | `model.preset` (`openrouter`, `openai`, `gemini`, `groq`, `ollama`, `lmstudio`, `custom`) |
| `CLIPY_MODEL_BASE_URL` | `model.baseUrl` |
| `CLIPY_MODEL_API_KEY` | `model.apiKey` |
| `CLIPY_MODEL` | `model.model` |
| `CLIPY_TRANSCRIBE` | `transcription.kind` |
| `CLIPY_TRANSCRIBE_API_KEY` | `transcription.apiKey` |
| `CLIPY_TRANSCRIBE_MODEL` | `transcription.model` |
| `CLIPY_TRANSCRIBE_BASE_URL` | `transcription.baseUrl` (OpenAI-compatible only) |
| `CLIPY_LOCAL_CONFIG` | the file's path |

## Config File Locations

`configPath(env, platform)` resolves the settings file location per OS:

| Platform | Path |
|---|---|
| **Override (all OS)** | `$CLIPY_LOCAL_CONFIG` (when set and non-blank, wins everywhere) |
| **macOS (`darwin`)** | `~/Library/Application Support/clipy-local/config.json` |
| **Windows (`win32`)** | `%APPDATA%\clipy-local\config.json` (falls back to `%USERPROFILE%\AppData\Roaming\clipy-local\config.json`) |
| **Linux & others** | `$XDG_CONFIG_HOME/clipy-local/config.json` (falls back to `~/.config/clipy-local/config.json` when `XDG_CONFIG_HOME` is unset or relative) |
