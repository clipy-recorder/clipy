# @clipy/moments

`@clipy/moments` identifies important moments in screen recordings that may be worth capturing as screenshots. It combines local interaction-based rules with optional AI analysis of transcript data.

## Features

- **Rules-based planning:** Detects useful moments from interactions such as clicks, keyboard activity, drawings, pointer activity, and highlights.
- **AI-assisted planning:** Uses transcript context to identify important spoken references and moments.
- **Local-first:** Works without an AI provider using local rules.
- **Moment fusion:** Combines spoken cues and interaction evidence.
- **Fallback support:** Can fall back to rules-only planning when model analysis fails.
- **Interaction limits:** Limits interaction data to avoid processing excessively large inputs.

## Usage

### Rules-only planning

Without a model provider, planning uses local rules.

```ts
import { planMoments } from "@clipy/moments";

const result = await planMoments(input);

console.log(result.plan.moments);
console.log(result.planner); // "rules"
```

### AI-assisted planning

A model provider can be configured to analyze transcript context.

```ts
import { planMoments, PROVIDER_BASE_URLS } from "@clipy/moments";

const result = await planMoments(input, {
  provider: {
    baseUrl: PROVIDER_BASE_URLS.openrouter,
    apiKey: process.env.OPENROUTER_API_KEY,
    model: "google/gemini-3.1-flash-lite",
  },
});

console.log(result.plan.moments);
console.log(result.planner); // "rules" or "rules+model"
```

The AI analyzes spoken cues, while interaction-based moments are detected using local rules.

## API

### `planMoments(input, options?)`

Plans important moments from recording transcript and interaction data.

**Parameters**

- `input`: Recording data containing transcript, interactions, click elements, and optional capture information.
- `options`: Optional planner configuration.

**Returns**

A `PlanResult` containing:

- `plan`: The generated moment plan.
- `planner`: `"rules"` or `"rules+model"`.
- `modelFallback`: Optional information about model failure when rules fallback is used.

### Options

| Option | Type | Description |
|---|---|---|
| `provider` | `ModelProvider \| null` | Model provider configuration. Omitted or `null` enables rules-only planning. |
| `signal` | `AbortSignal` | Allows planning to be cancelled. |
| `onModelFailure` | `"throw" \| "rules"` | Determines how model failures are handled. Default is `"throw"`. |

#### `onModelFailure`

- `"throw"`: Throws the model planning error.
- `"rules"`: Falls back to rules-only planning if model analysis fails. The fallback is not used when the request is aborted.

## Model provider

### `ModelProvider`

```ts
interface ModelProvider {
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
}
```

| Property | Description |
|---|---|
| `baseUrl` | Base URL of the API endpoint. |
| `apiKey` | Optional API key for authentication. |
| `model` | Model identifier. |
| `headers` | Optional additional HTTP headers. |

### `PROVIDER_BASE_URLS`

The package provides preset base URLs for common providers.

| Provider | Base URL |
|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `https://api.groq.com/openai/v1` |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |

Custom OpenAI-compatible endpoints can also be configured.

## `boundInteractions(events, limit?)`

Limits the number of interaction events processed by the planner.

```ts
import {
  boundInteractions,
  MAX_PLANNER_INTERACTIONS,
} from "@clipy/moments";

const boundedEvents = boundInteractions(
  interactions,
  MAX_PLANNER_INTERACTIONS
);
```

The default limit is **8,000 interactions**.

When the limit is exceeded:

- Button, keyboard, and annotation events are prioritized.
- Paired key and button events are kept together where possible.
- Scroll events are sampled next.
- Remaining events are sampled evenly.

Events within the limit are returned unchanged.

## Input

The planner accepts a `LocalMomentInput` containing:

- `durationMs`: Recording duration in milliseconds.
- `transcript`: Transcript segments with start time, end time, and text.
- `interactions`: Pointer, click, scroll, keyboard, and annotation events.
- `clickElements`: Click-related labels and roles.
- `interactionSelection`: Bounded interaction sample information.
- `capture`: Optional capture dimensions and coordinates.
- `schemaVersion`: Optional schema version.

Transcript and interaction timestamps are measured in milliseconds.

## Output

The plan contains selected moments. Each moment may include:

- `timestamp_ms`: Moment timestamp.
- `frame_at_ms`: Frame selection timestamp.
- `reason`: Why the moment was selected.
- `source`: Source of the moment, such as spoken, fused, flare, draw, click, or hover.
- `x` and `y`: Optional coordinates.

The planner supports legacy output and schema version 2.

## Error handling

The package exports `LLMError` and `describePlannerError` for model-related error handling.

Errors may include:

- `provider_error`
- `unparseable_json`
- `empty_completion`
- `invalid_output`
- `timeout`
- `aborted`
- `network`

Certain transient errors may be retried before the planner fails.

## Generated source

Files under `src/generated/` are generated from the monorepo source.

Do not edit generated files directly. Update the original source and run the repository synchronization script when generated changes are required.

## License

Apache-2.0