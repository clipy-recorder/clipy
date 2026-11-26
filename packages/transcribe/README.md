# @clipy/transcribe

Audio transcription engine supporting both on-device local models and external speech-to-text API providers.

## Providers & Engines

- **On-Device (`local`):** Uses Sherpa-ONNX with downloaded models (`english-fast`, `multilingual`). Audio never leaves the machine.
- **Hosted Cloud Providers:**
  - OpenAI (`whisper-1`)
  - Groq (`whisper-large-v3`)
  - Deepgram (`nova-2` / `nova-3`)
  - AssemblyAI (`best` / `nano`)
  - ElevenLabs (`scribe_v1`)
  - Google Gemini (`gemini-2.5-flash` / `gemini-3.5-flash-lite`)
- **OpenAI-Compatible:** Connects to local or self-hosted transcription endpoints with custom base URLs.
- **Rate-Limit Resilience:** Automatically retries HTTP 429 and 503 responses honoring `Retry-After` headers.
- **None (`none`):** Skips transcription, creating a gap over the recording span.

## Usage

```typescript
import { transcribe } from "@clipy/transcribe";

// Transcribe with on-device local model
const result = await transcribe("audio.wav", {
  kind: "local",
  model: "english-fast",
});

for (const segment of result.segments) {
  console.log(`[${segment.startMs}ms - ${segment.endMs}ms] ${segment.text}`);
}
```

## License

Apache-2.0
