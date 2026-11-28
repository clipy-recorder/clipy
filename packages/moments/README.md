# @clipy/moments

Detects and plans key moments worth capturing as screenshots in screen recordings.

Implements the moment detection algorithms of Clipy locally on the user's machine:
- **Rules (Offline & On-Device):** Hold-to-highlight flares, cursor pointer rests, pen annotation strokes, and click clusters extracted from interaction sidecars.
- **Spoken Cues (Optional):** Employs an LLM to identify verbal callouts ("click here", "look at this error", "notice how this works") grounded in the transcript.

## Features

- **Rules-Only Fallback:** Zero data leaves the machine when no model provider is configured.
- **Resilient Output Parsing:** Automatically strips Markdown code fences (` ```json `) even when preceded or followed by conversational prose.
- **Local Model Compatibility:** Automatically falls back when local OpenAI-compatible endpoints (such as LM Studio or llama.cpp) reject `response_format: { type: "json_object" }`.

## Usage

```typescript
import { planMoments } from "@clipy/moments";

const plan = await planMoments({
  durationMs: 30000,
  transcript: [
    { startMs: 2000, endMs: 3500, text: "click on the save button" },
  ],
  interactions: [
    { kind: "move", time_ms: 1000, x: 200, y: 150 },
    { kind: "down", time_ms: 2200, x: 200, y: 150, button: 1 },
    { kind: "up", time_ms: 2300, x: 200, y: 150, button: 1 },
  ],
  clickElements: [
    { time_ms: 2200, role: "AXButton", label: "Save" },
  ],
  capture: {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    output_width: 1920,
    output_height: 1080,
  },
});

console.log(`Detected ${plan.moments.length} moments`);
for (const moment of plan.moments) {
  console.log(`[${moment.timestamp_ms}ms] (${moment.source}): ${moment.reason}`);
}
```

## License

Apache-2.0
