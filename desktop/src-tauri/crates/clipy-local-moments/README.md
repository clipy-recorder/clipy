# clipy-local-moments

Picks the moments of a screen recording worth a screenshot, on the user's
machine. The desktop app's local edition uses it in place of Clipy's hosted
moment selection.

- **Rules, always, offline.** Hold-Control flares, pen drawings, click clusters
  with their accessibility labels, and pointer rests, read from the
  interaction sidecar. Nothing leaves the machine.
- **Spoken cues, optional.** When the user has configured a model provider,
  the transcript and a compacted cursor context go to its OpenAI-compatible
  `/chat/completions` endpoint. The model returns spoken cues ("this button",
  "it breaks here"), and the cues are fused with the same evidence. Fusion
  stays deterministic and local.

It is a port of the rules-only and model paths of `planMoments` in
`@clipy/moments` (`packages/moments`), held to its output by golden files.
For a plain-language explanation of what each rule notices while recording,
see [Key moments in a recording](../../../../docs/moments.md).

## API

```rust
use clipy_local_moments::{plan_rules, plan_with_provider, Input, Plan, Planner, Preset, ProviderConfig};

let input: Input = serde_json::from_value(json)?;     // or build it field by field
let plan: Plan = plan_rules(&input);                  // never fails, never touches the network

let config = ProviderConfig::from_preset(Preset::OpenRouter, Some(key), None, None)?;
let plan = match plan_with_provider(&input, &config).await {
    Ok(plan) => plan,                                 // plan.planner says whether a model answered
    Err(error) => {
        // error.describe() is safe to log; fall back as the caller sees fit
        plan_rules(&input)
    }
};
```

### Input

`Input` mirrors the TypeScript planner input. Top-level fields are camelCase;
events, click elements and capture geometry keep the sidecar's
(`recording.cursor.json`) snake_case names. Unknown fields are ignored, so a
sidecar event with `cursor_type` or `render_x` deserializes as is.

| Field | Meaning |
|---|---|
| `durationMs` | Recording length in ms (positive integer). |
| `transcript` | `[{startMs, endMs, text}]` on the recording clock. |
| `interactions` | Sidecar events: `kind` (`move`, `down`, `up`, `scroll`, `key_down`, `key_up`, `annotation`), `time_ms`, optional `x`, `y`, `button`, `key_code`, `delta_x`, `delta_y`, `active`. |
| `clickElements` | `[{time_ms, role, label}]`, the accessibility element under each click. |
| `capture` | Optional `{x, y, width, height, output_width?, output_height?}` in event coordinates. Without it no moment has `x`/`y` and pen strokes cannot be placed. |
| `captureTimeline` | Optional `[{time_ms, x, y, width, height}]` for a window-following take. Not in the TypeScript input; empty gives exactly its output. |
| `keycodeDialect` | `mac` (default, what the TypeScript local planner uses) or `dom` for Windows virtual-key codes (Control is 17). |

`Input::validate()` applies the TypeScript input limits (at most 8000 events,
2000 click elements, 100,000 segments, times within 12 hours, transcript inside
the recording). `plan_with_provider` calls it before sending anything;
`plan_rules` accepts any input, including a full sidecar.

### Output

`Plan { moments, planner }`. Each `Moment` has `timestamp_ms` (what the reason
refers to), `frame_at_ms` (the instant to screenshot), `reason`, `source`
(`spoken`, `fused`, `flare`, `draw`, `click`, `hover`) and, with capture
geometry, `x`/`y` normalized to 0..1. Moments are in timestamp order, one per
timestamp, at most 96. This is the v2 plan the desktop app already parses
(`validate_moments` in `local/mod.rs`). `Planner::Rules` serializes as
`"rules"`, `Planner::RulesAndModel` as `"rules+model"`; it is `rules+model`
only when a model answered (an empty transcript skips the model).

### Provider

`ProviderConfig { base_url, api_key, model, headers, attempt_timeout, retry_delays }`,
or `ProviderConfig::from_preset(preset, key, model, base_url)` with the presets
of `packages/config/src/presets.ts`:

| Preset | Base URL | Default model | Key |
|---|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-3.1-flash-lite` | required; sends `HTTP-Referer: https://clipy.online`, `X-Title: Clipy` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` | required |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | required |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | required |
| Ollama | `http://127.0.0.1:11434/v1` | none, must be given | none |
| LM Studio | `http://127.0.0.1:1234/v1` | none, must be given | none |
| Custom | must be given | must be given | optional |

The request is `POST {base}/chat/completions` with the TypeScript system
prompt (`SYSTEM_PROMPT`), the user payload `{durationMs, transcript,
cursorContext}`, `temperature: 0`, `max_tokens: 4096` and
`response_format: {"type":"json_object"}`. A code-fenced answer is accepted.
Each attempt has 45 s (including reading the answer); there are 3 attempts,
1 s and then 3 s apart, on network errors, timeouts, 408, 429, 5xx, an empty or
unparseable completion, and output that fails validation. Other 4xx answers
and an answer over 2 MiB are not retried. Redirects are never followed.
Nothing is logged; errors carry only a classification and the upstream status,
never a key, the transcript or a provider's error body, and `Debug` on the
config redacts the key. `ProviderConfig::host()` names the host for the AREC
disclosure.

The crate has no async runtime dependency: `reqwest` runs on the caller's
Tokio runtime, and the two retry waits use a short-lived timer thread.

## Parity with TypeScript

`tests/golden/*.json` are written by
`packages/moments/scripts/make-golden.mjs`, which runs the TypeScript
`planMoments` over twelve synthetic inputs, rules only and with a stubbed model
that returns given spoken cues. `cargo test` reproduces every one: moments,
order, reasons byte for byte, frame times, coordinates to 1e-6, and for the
model cases the exact request body. To refresh them after a change to the
TypeScript rules:

```sh
pnpm install
node packages/moments/scripts/make-golden.mjs
cd desktop/src-tauri/crates/clipy-local-moments && cargo test
```

JavaScript behaviour the port reproduces on purpose: `toFixed` rounding ties
away from zero (Rust's `{:.N}` rounds them to even), `Math.round`, number
printing in JSON, UTF-16 string slicing for every length limit, and the
JavaScript whitespace class for `trim` and label cleanup.

Known differences:

- A length cut through a surrogate pair leaves half an emoji in JavaScript;
  Rust strings cannot hold that, so it becomes U+FFFD (what any UTF-8 encoder
  makes of the JavaScript string). The golden files record the TypeScript
  output the same way (`text-edges` covers it).
- A 3xx answer is `PlannerError::Redirect` and is not retried. TypeScript's
  `fetch(..., {redirect: "error"})` reports it as a network error, which is
  retried.
- A completion whose `content` is a non-zero number or `true` is
  `Unparseable` here and invalid output in TypeScript. Both are retried.
- Invalid-output issue strings (`too_big@moments.0.timestamp_ms`) follow
  Zod's `code@path` shape but are not guaranteed to be Zod's exact codes.
- `captureTimeline` and `keycodeDialect` are additions; with their defaults
  the output is the TypeScript output.
- Only the v2 plan is produced (the TypeScript planner also has a v1
  projection for desktop builds from before September 2026).
