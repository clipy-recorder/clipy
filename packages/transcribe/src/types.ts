/** One spoken stretch, in milliseconds from the start of the recording. */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export type LocalModelId = "english-fast" | "multilingual";

/**
 * Where the transcript comes from. `local` runs a downloaded model on this
 * machine; every other kind sends the audio to that provider with the user's
 * own key.
 *
 * `baseUrl` on the hosted providers is optional and only needed for a
 * regional endpoint, a proxy or a test server.
 */
export type TranscriptionConfig =
  | { kind: "none"; language?: string }
  | { kind: "local"; model: LocalModelId; language?: string }
  | {
      kind: "openai-compatible";
      baseUrl: string;
      apiKey: string;
      model: string;
      language?: string;
    }
  | {
      kind: "deepgram" | "assemblyai" | "elevenlabs" | "gemini";
      apiKey: string;
      model?: string;
      baseUrl?: string;
      language?: string;
    };
export interface TranscriptGap {
  startMs: number;
  endMs: number;
  reason: string;
}

export interface TranscribeResult {
  segments: TranscriptSegment[];
  /** Which engine produced the segments, e.g. `local:english-fast` or `deepgram:nova-3`. */
  engine: string;
  /** Language code when the engine reports one. */
  language?: string;
  /** Stretches of the recording that have no transcript, and why. */
  gaps: TranscriptGap[];
}

export interface TranscribeProgress {
  stage: "extract" | "download" | "transcribe";
  fraction: number;
}

export interface TranscribeOptions {
  signal?: AbortSignal;
  modelDir?: string;
  onProgress?: (p: TranscribeProgress) => void;
  /**
   * Path of the sherpa-onnx-node entry file for on-device transcription. The
   * engine is not a dependency of this package: the host installs it (the CLI
   * downloads it on first use) and says where. When absent it is resolved from
   * this package's location.
   */
  speechEngine?: string;
}
