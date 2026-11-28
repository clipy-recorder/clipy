import { readFile } from "node:fs/promises";
import { BYTES_PER_SECOND, detectSilences, measureMeanVolume, readWavSlice, silenceThresholds, throwIfAborted, type WavInfo } from "../audio.js";
import { mergePieces, planChunks, speechSecIn, trimToSpeech, type ChunkPlan, type RelativeSegment, type SilenceSpan } from "../chunking.js";
import type { TranscriptGap, TranscriptSegment } from "../types.js";

/** What every engine is handed: the extracted 16 kHz mono WAV and a way to find its silences. */
export interface AudioInput {
  wavPath: string;
  info: WavInfo;
  /** Silence spans (pauses to cut at, and to trim segment edges), computed once on first use. */
  silences: () => Promise<SilenceSpan[]>;
  /**
   * Spans quiet enough that no speech can be in them, a much stricter test
   * than `silences`. A piece is skipped only when these cover it. Absent:
   * nothing is skipped.
   */
  noSpeech?: () => Promise<SilenceSpan[]>;
  /** Whether the recording as a whole is quiet (see silenceThresholds). Absent: not quiet. */
  quiet?: () => Promise<boolean>;
  signal?: AbortSignal;
  /** 0..1 over the transcription stage. */
  onProgress?: (fraction: number) => void;
}

/**
 * The AudioInput for an extracted WAV. Both silence lists are computed at
 * most once, with thresholds that follow the recording's own loudness, so
 * quiet speech is not taken for silence.
 */
export function audioInputFor(wavPath: string, info: WavInfo, signal?: AbortSignal, onProgress?: (fraction: number) => void): AudioInput {
  type Levels = ReturnType<typeof silenceThresholds>;
  let levels: Promise<Levels> | null = null;
  const thresholds = () => (levels ??= measureMeanVolume(wavPath, signal).then(silenceThresholds));
  const at = (pick: (t: Levels) => number) => {
    let spans: Promise<SilenceSpan[]> | null = null;
    return () =>
      (spans ??= thresholds()
        .then((t) => detectSilences(wavPath, signal, info.durationSec, pick(t)))
        .then((list) => list.map((x) => ({ startSec: x.startSec, endSec: Math.min(x.endSec, info.durationSec) }))));
  };
  return {
    wavPath,
    info,
    signal,
    silences: at((t) => t.splitDb),
    noSpeech: at((t) => t.skipDb),
    quiet: () => thresholds().then((t) => t.quiet),
    onProgress,
  };
}

export interface EngineOutput {
  segments: TranscriptSegment[];
  engine: string;
  language?: string;
  gaps: TranscriptGap[];
}

export interface PieceOutput {
  segments: RelativeSegment[];
  language?: string;
}

export interface ChunkLimits {
  targetSec: number;
  maxSec: number;
}

/** Longest WAV (header included) that fits in `maxBytes`. */
export function maxSecForBytes(maxBytes: number): number {
  return Math.floor((maxBytes - 44) / BYTES_PER_SECOND);
}

/** A piece with less speech than this (outside `noSpeech` spans) is not sent. */
export const MIN_SPEECH_SEC = 0.3;

export const NO_SPEECH_GAP_REASON = "no speech detected";

/**
 * Of a multi-piece plan, the pieces with no speech, which are not sent.
 *
 * - "strict" (Parakeet, which says nothing over noise): only pieces that the
 *   strict `noSpeech` spans cover.
 * - "invents" (Whisper and the hosted providers, which turn fan noise into
 *   "Thank you."): also pieces the ordinary `silences` cover, unless the
 *   recording is quiet, where those spans could hide speech.
 *
 * A recording that is one piece is always transcribed.
 */
export async function piecesWithoutSpeech(input: AudioInput, plan: ChunkPlan[], engine: "strict" | "invents"): Promise<Set<number>> {
  if (plan.length <= 1) return new Set();
  let spans: SilenceSpan[] | null = null;
  if (engine === "invents" && !(await input.quiet?.())) spans = await input.silences();
  else if (input.noSpeech) spans = await input.noSpeech();
  if (!spans) return new Set();
  const quiet = spans;
  return new Set(
    plan.filter((p) => speechSecIn(quiet, p.extractStartSec, p.extractStartSec + p.extractDurSec) < MIN_SPEECH_SEC).map((p) => p.index),
  );
}

/** The part of the timeline a piece owns, as a gap. */
export function pieceGap(p: ChunkPlan, reason: string): TranscriptGap {
  const start = Math.max(p.keepStartSec, p.extractStartSec);
  const end = Math.min(p.keepEndSec, p.extractStartSec + p.extractDurSec);
  return { startMs: Math.round(start * 1000), endMs: Math.round(end * 1000), reason };
}

/**
 * Send the audio to a provider in pieces small enough for its upload limit,
 * cut in silences, one piece at a time, and merge the results. A piece with
 * no speech at all is not sent and is reported as a gap.
 */
export async function runInPieces(
  input: AudioInput,
  limits: ChunkLimits,
  run: (wav: Buffer, durSec: number) => Promise<PieceOutput>,
): Promise<{ segments: TranscriptSegment[]; language?: string; gaps: TranscriptGap[] }> {
  const total = input.info.durationSec;
  const silences = total > limits.maxSec ? await input.silences() : [];
  const plan = planChunks(silences, total, { targetSec: limits.targetSec, maxSec: limits.maxSec, overlapSec: 0, minSec: Math.min(15, limits.targetSec / 2) });
  const skip = await piecesWithoutSpeech(input, plan, "invents");
  const pieces: Array<{ plan: (typeof plan)[number]; segments: RelativeSegment[] }> = [];
  const gaps: TranscriptGap[] = [];
  let language: string | undefined;
  for (const [i, p] of plan.entries()) {
    throwIfAborted(input.signal);
    if (skip.has(p.index)) {
      gaps.push(pieceGap(p, NO_SPEECH_GAP_REASON));
      input.onProgress?.((i + 1) / plan.length);
      continue;
    }
    const wav =
      plan.length === 1 ? await readFile(input.wavPath) : await readWavSlice(input.wavPath, input.info, p.extractStartSec, p.extractDurSec);
    const out = await run(wav, p.extractDurSec);
    language ??= out.language;
    pieces.push({ plan: p, segments: out.segments });
    input.onProgress?.((i + 1) / plan.length);
  }
  return { segments: mergePieces(pieces), language, gaps };
}

/** A provider that only returned plain text: one segment over the speech in the piece. */
export function wholePieceSegment(text: string, durSec: number, silences: SilenceSpan[] = []): RelativeSegment[] {
  const t = text.trim();
  if (!t) return [];
  const span = trimToSpeech(silences, 0, durSec);
  return [{ start: span.startSec, end: Math.max(span.endSec, span.startSec), text: t }];
}

export function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}


// [ISO 639-1 code, ISO 639-3 code, English name]. Covers the languages Whisper can report.
const LANGUAGES: ReadonlyArray<readonly [string, string, string]> = [
  ["en", "eng", "english"], ["zh", "zho", "chinese"], ["de", "deu", "german"], ["es", "spa", "spanish"],
  ["ru", "rus", "russian"], ["ko", "kor", "korean"], ["fr", "fra", "french"], ["ja", "jpn", "japanese"],
  ["pt", "por", "portuguese"], ["tr", "tur", "turkish"], ["pl", "pol", "polish"], ["ca", "cat", "catalan"],
  ["nl", "nld", "dutch"], ["ar", "ara", "arabic"], ["sv", "swe", "swedish"], ["it", "ita", "italian"],
  ["id", "ind", "indonesian"], ["hi", "hin", "hindi"], ["fi", "fin", "finnish"], ["vi", "vie", "vietnamese"],
  ["he", "heb", "hebrew"], ["uk", "ukr", "ukrainian"], ["el", "ell", "greek"], ["ms", "msa", "malay"],
  ["cs", "ces", "czech"], ["ro", "ron", "romanian"], ["da", "dan", "danish"], ["hu", "hun", "hungarian"],
  ["ta", "tam", "tamil"], ["no", "nor", "norwegian"], ["th", "tha", "thai"], ["ur", "urd", "urdu"],
  ["hr", "hrv", "croatian"], ["bg", "bul", "bulgarian"], ["lt", "lit", "lithuanian"], ["la", "lat", "latin"],
  ["mi", "mri", "maori"], ["ml", "mal", "malayalam"], ["cy", "cym", "welsh"], ["sk", "slk", "slovak"],
  ["te", "tel", "telugu"], ["fa", "fas", "persian"], ["lv", "lav", "latvian"], ["bn", "ben", "bengali"],
  ["sr", "srp", "serbian"], ["az", "aze", "azerbaijani"], ["sl", "slv", "slovenian"], ["kn", "kan", "kannada"],
  ["et", "est", "estonian"], ["mk", "mkd", "macedonian"], ["br", "bre", "breton"], ["eu", "eus", "basque"],
  ["is", "isl", "icelandic"], ["hy", "hye", "armenian"], ["ne", "nep", "nepali"], ["mn", "mon", "mongolian"],
  ["bs", "bos", "bosnian"], ["kk", "kaz", "kazakh"], ["sq", "sqi", "albanian"], ["sw", "swa", "swahili"],
  ["gl", "glg", "galician"], ["mr", "mar", "marathi"], ["pa", "pan", "punjabi"], ["si", "sin", "sinhala"],
  ["km", "khm", "khmer"], ["sn", "sna", "shona"], ["yo", "yor", "yoruba"], ["so", "som", "somali"],
  ["af", "afr", "afrikaans"], ["oc", "oci", "occitan"], ["ka", "kat", "georgian"], ["be", "bel", "belarusian"],
  ["tg", "tgk", "tajik"], ["sd", "snd", "sindhi"], ["gu", "guj", "gujarati"], ["am", "amh", "amharic"],
  ["yi", "yid", "yiddish"], ["lo", "lao", "lao"], ["uz", "uzb", "uzbek"], ["fo", "fao", "faroese"],
  ["ht", "hat", "haitian creole"], ["ps", "pus", "pashto"], ["tk", "tuk", "turkmen"], ["nn", "nno", "nynorsk"],
  ["mt", "mlt", "maltese"], ["sa", "san", "sanskrit"], ["lb", "ltz", "luxembourgish"], ["my", "mya", "myanmar"],
  ["bo", "bod", "tibetan"], ["tl", "tgl", "tagalog"], ["mg", "mlg", "malagasy"], ["as", "asm", "assamese"],
  ["tt", "tat", "tatar"], ["ln", "lin", "lingala"], ["ha", "hau", "hausa"], ["ba", "bak", "bashkir"],
  ["jv", "jav", "javanese"], ["su", "sun", "sundanese"],
];

// Other names Whisper uses for the same language.
const ALIASES: Record<string, string> = {
  castilian: "es", valencian: "ca", flemish: "nl", burmese: "my", sinhalese: "si",
  panjabi: "pa", pushto: "ps", letzeburgesch: "lb", moldavian: "ro", moldovan: "ro",
};

// One lookup for all three forms: "en", "eng" and "english" all give "en".
const LOOKUP = new Map<string, string>(Object.entries(ALIASES));
for (const [code, code3, name] of LANGUAGES) {
  LOOKUP.set(code, code);
  LOOKUP.set(code3, code);
  LOOKUP.set(name, code);
}

/**
 * Turns whatever a provider reports into a lowercase ISO 639-1 code:
 * "english" -> "en", "eng" -> "en", "en_us" / "en-US" -> "en".
 * Returns undefined when the value is empty or not a language we know,
 * so the caller can leave `language` out.
 */
export function normalizeLanguage(value: string | null | undefined): string | undefined {
  const key = value?.trim().toLowerCase();
  if (!key) return undefined;
  const direct = LOOKUP.get(key);
  if (direct) return direct;
  // Region forms like "en-US", "en_us", "pt-BR": keep only the language part.
  return LOOKUP.get(key.split(/[-_]/)[0]);
}