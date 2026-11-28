/** One spoken stretch, in milliseconds from the start of the recording. */
export interface TranscriptSegment {
  /** Start of the segment in milliseconds from the beginning of the recording. */
  startMs: number;
  /** End of the segment in milliseconds from the beginning of the recording. */
  endMs: number;
  /** The transcribed text for this time range. */
  text: string;
}

/** Identifier for a bundled on-device speech model. */
export type LocalModelId = "english-fast" | "multilingual";

/**
 * Where the transcript comes from. `local` runs a downloaded model on this
 * machine; every other kind sends the audio to that provider with the user's
 * own key.
 *
 * `baseUrl` on the hosted providers is optional and only needed for a
 * regional endpoint, a proxy or a test server.
 *
 * @example On-device (nothing leaves the machine)
 * ```ts
 * const config: TranscriptionConfig = { kind: "local", model: "english-fast" };
 * ```
 *
 * @example OpenAI Whisper
 * ```ts
 * const config: TranscriptionConfig = { kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-...", model: "whisper-1" };
 * ```
 */
export type TranscriptionConfig =
  | { kind: "none" }
  | { kind: "local"; model: LocalModelId }
  | { kind: "openai-compatible"; baseUrl: string; apiKey: string; model: string }
  | {
      kind: "deepgram" | "assemblyai" | "elevenlabs" | "gemini";
      apiKey: string;
      model?: string;
      baseUrl?: string;
    };

/** A stretch of a recording that could not be transcribed, and why. */
export interface TranscriptGap {
  /** Start of the untranscribed stretch in milliseconds. */
  startMs: number;
  /** End of the untranscribed stretch in milliseconds. */
  endMs: number;
  /** Human-readable reason, e.g. `"no audio track"` or `"transcription off"`. */
  reason: string;
}

/** The result of a {@link transcribe} call. */
export interface TranscribeResult {
  /** The transcribed segments in chronological order. Empty when transcription is off or the file has no audio. */
  segments: TranscriptSegment[];
  /** Which engine produced the segments, e.g. `local:english-fast` or `deepgram:nova-3`. */
  engine: string;
  /** BCP-47 language code when the engine reports one, e.g. `"en"` or `"fr"`. */
  language?: string;
  /** Stretches of the recording that have no transcript, and why. */
  gaps: TranscriptGap[];
}

/** Progress update emitted during a {@link transcribe} call. */
export interface TranscribeProgress {
  /** Current processing stage. */
  stage: "extract" | "download" | "transcribe";
  /** Fraction completed for the current stage, in the range [0, 1]. */
  fraction: number;
}

/** Options for {@link transcribe}. */
export interface TranscribeOptions {
  /** An AbortSignal to cancel the transcription mid-flight. */
  signal?: AbortSignal;
  /** Directory where local speech models are stored. Defaults to a platform cache directory. */
  modelDir?: string;
  /** Called with progress updates throughout extraction, download, and transcription. */
  onProgress?: (p: TranscribeProgress) => void;
  /**
   * Path of the sherpa-onnx-node entry file for on-device transcription. The
   * engine is not a dependency of this package: the host installs it (the CLI
   * downloads it on first use) and says where. When absent it is resolved from
   * this package's location.
   */
  speechEngine?: string;
}
