# @clipy/local-config

Settings for Clipy Local: which model provider (if any) reads the transcript for spoken cues, and how recordings are transcribed.

> **Note:** This is an internal workspace package (`"private": true`) and is not published on npm.

## Usage

Use `loadConfig` to read the resolved settings (file + environment variable overrides) and `saveConfig` to update the settings file.

```ts
import { loadConfig, saveConfig } from "@clipy/local-config";

// Save settings (each top-level field replaces the saved one; pass `model: null` to clear)
saveConfig({
  model: { preset: "openrouter", apiKey: "sk-or-...", model: "anthropic/claude-sonnet-4" },
  transcription: { kind: "local", model: "english-fast" },
});

// Load settings (reads from `configPath(env)` and applies env var overrides)
const config = loadConfig();
// config.model        -> ModelProvider | null
// config.modelPreset  -> ModelPreset | null
// config.transcription -> TranscriptionConfig
// config.telemetry    -> false (always off in the local edition)
