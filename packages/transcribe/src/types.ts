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
  | { kind: "none" }
  | { kind: "local"; model: LocalModelId }
  | { kind: "openai-compatible"; baseUrl: string; apiKey: string; model: string }
  | {
      kind: "deepgram" | "assemblyai" | "elevenlabs" | "gemini";
      apiKey: string;
      model?: string;
      baseUrl?: string;
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

/**
 * Which audio of a file to transcribe when it has more than one audio track
 * (a recording that keeps the microphone and the system sound apart): one
 * track by its index among the audio tracks, from 0, or "mix" for every
 * audio track mixed together.
 */
export type AudioTrack = number | "mix";

export interface TranscribeProgress {
  stage: "extract" | "download" | "transcribe";
  fraction: number;
}

export interface TranscribeOptions {
  signal?: AbortSignal;
  modelDir?: string;
  onProgress?: (p: TranscribeProgress) => void;
  /**
   * The audio track to transcribe, or "mix" for all of them. Unset, ffmpeg
   * picks one track by its own rule (the one with the most channels), which
   * can be a system-sound track rather than the speech.
   */
  audioTrack?: AudioTrack;
  /**
   * Path of the sherpa-onnx-node entry file for on-device transcription. The
   * engine is not a dependency of this package: the host installs it (the CLI
   * downloads it on first use) and says where. When absent it is resolved from
   * this package's location.
   */
  speechEngine?: string;
}
