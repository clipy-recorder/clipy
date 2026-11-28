/**
 * Deterministic Secret & PII Auto-Redaction Gate.
 *
 * Zero external dependencies — pure regex + Shannon entropy. The gate replaces
 * matched secrets with deterministic indexed placeholders so the same secret
 * always maps to the same label within one redaction session:
 *
 *   "token sk-or-v1-abc123 and again sk-or-v1-abc123"
 *   → "token [REDACTED_API_KEY_1] and again [REDACTED_API_KEY_1]"
 *
 * Usage: create a `RedactionSession`, call `redactText()` or the higher-level
 * `redactSegments()` and `redactClickLabels()`. All calls on the same session
 * share the same index mapping.
 */

import {
  HIGH_ENTROPY_MIN_BITS,
  HIGH_ENTROPY_TOKEN,
  isSafeIP,
  isLuhnValid,
  PATTERN_CLASSES,
  REDACTION_CLASS_NAMES,
  SECRET_CONTEXT_KEYWORDS,
  shannonEntropy,
  type PatternClass,
  type RedactionClassName,
} from "./patterns.js";

export { REDACTION_CLASS_NAMES, type RedactionClassName } from "./patterns.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RedactionOptions {
  /** Which pattern classes to apply. Default: all. */
  classes?: readonly RedactionClassName[];
  /** Exact strings to never redact. */
  allowlist?: readonly string[];
  /** User-defined patterns compiled to regexps. */
  custom?: readonly { pattern: RegExp; label: string }[];
}

export interface RedactionSummary {
  /** Counts per class name. */
  counts: Partial<Record<string, number>>;
  /** Placeholder labels created, e.g. ["[REDACTED_API_KEY_1]"]. Never raw secret values. */
  placeholders: string[];
}

export interface RedactResult {
  redacted: string;
  count: number;
  summary: RedactionSummary;
}

// ---------------------------------------------------------------------------
// Session: tracks seen secrets → deterministic indexed placeholders
// ---------------------------------------------------------------------------

export class RedactionSession {
  /** Map from raw secret value → placeholder string. */
  private readonly seen = new Map<string, string>();
  /** Next index per label. */
  private readonly nextIndex = new Map<string, number>();
  /** Running counts per class. */
  private readonly counts: Record<string, number> = {};
  /** Running total. */
  private total = 0;

  private readonly enabledClasses: Set<RedactionClassName>;
  private readonly allowlistSet: Set<string>;
  private readonly customPatterns: readonly { pattern: RegExp; label: string }[];
  private readonly activeClasses: PatternClass[];

  constructor(options: RedactionOptions = {}) {
    this.enabledClasses = new Set(options.classes ?? REDACTION_CLASS_NAMES);
    this.allowlistSet = new Set(options.allowlist ?? []);
    this.customPatterns = options.custom ?? [];
    this.activeClasses = PATTERN_CLASSES.filter((c) => this.enabledClasses.has(c.name));
  }

  /** Allocate or return the existing placeholder for a raw secret. */
  private placeholder(raw: string, label: string, className: string): string {
    const existing = this.seen.get(raw);
    if (existing) return existing;
    const idx = (this.nextIndex.get(label) ?? 0) + 1;
    this.nextIndex.set(label, idx);
    const ph = `[REDACTED_${label}_${idx}]`;
    this.seen.set(raw, ph);
    this.counts[className] = (this.counts[className] ?? 0) + 1;
    this.total += 1;
    return ph;
  }

  /** Look up an already-assigned placeholder without allocating. */
  private existingPlaceholder(raw: string): string | undefined {
    return this.seen.get(raw);
  }

  /**
   * Redact secrets in `text`. Returns the redacted string, the number of
   * distinct secrets found (across all calls on this session), and a summary.
   */
  redactText(text: string): RedactResult {
    let result = text;

    for (const cls of this.activeClasses) {
      if (cls.name === "highEntropy") continue; // handled separately below
      for (const pattern of cls.patterns) {
        result = this.applyPattern(result, pattern, cls.name, cls.label, cls);
      }
    }

    // Custom patterns
    for (const { pattern, label } of this.customPatterns) {
      result = this.applyPattern(result, pattern, "custom", label);
    }

    // High-entropy contextual fallback
    if (this.enabledClasses.has("highEntropy")) {
      result = this.applyHighEntropy(result);
    }

    return {
      redacted: result,
      count: this.total,
      summary: {
        counts: { ...this.counts },
        placeholders: [...this.seen.values()],
      },
    };
  }

  /**
   * Apply a single regex pattern class to the text.
   * We need to reset `lastIndex` on every call because the same regex
   * object is reused across sessions.
   */
  private applyPattern(text: string, pattern: RegExp, className: string, label: string, cls?: PatternClass): string {
    // Create a fresh regex from the pattern to avoid shared lastIndex state
    const re = new RegExp(pattern.source, pattern.flags);
    const parts: string[] = [];
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0];

      // Allowlist check
      if (this.allowlistSet.has(raw)) continue;

      // Special validation for IP addresses
      if (cls?.name === "ipAddresses" && isSafeIP(raw)) continue;

      // Special validation for credit cards (Luhn)
      if (cls?.name === "creditCards") {
        const digits = raw.replace(/\D/g, "");
        if (!isLuhnValid(digits)) continue;
      }

      // SSN validation: reject patterns that look like dates (19xx-xx-xx, 20xx-xx-xx)
      if (cls?.name === "ssns") {
        if (/^(?:19|20)\d\d-/.test(raw)) continue;
      }

      const ph = this.placeholder(raw, label, className);
      parts.push(text.slice(lastEnd, match.index), ph);
      lastEnd = match.index + raw.length;
    }
    if (parts.length === 0) return text;
    parts.push(text.slice(lastEnd));
    return parts.join("");
  }

  /**
   * Contextual Shannon entropy fallback: redact long alphanumeric tokens
   * that appear near secret-context keywords and have high entropy.
   */
  private applyHighEntropy(text: string): string {
    const re = new RegExp(HIGH_ENTROPY_TOKEN.source, HIGH_ENTROPY_TOKEN.flags);
    const parts: string[] = [];
    let lastEnd = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[0];

      // Skip if it's already been caught by another pattern
      if (this.existingPlaceholder(raw)) continue;

      // Skip allowlisted values
      if (this.allowlistSet.has(raw)) continue;

      // Must have high enough entropy
      if (shannonEntropy(raw) < HIGH_ENTROPY_MIN_BITS) continue;

      // Must be preceded by a secret-context keyword in the nearby text
      // Check the 60 characters before the match
      const contextStart = Math.max(0, match.index - 60);
      const context = text.slice(contextStart, match.index);
      if (!SECRET_CONTEXT_KEYWORDS.test(context)) continue;

      // Skip things that look like UUIDs
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) continue;

      // Skip things that look like git commit SHAs (exactly 40 hex chars)
      if (/^[0-9a-f]{40}$/i.test(raw)) continue;

      const ph = this.placeholder(raw, "SECRET", "highEntropy");
      parts.push(text.slice(lastEnd, match.index), ph);
      lastEnd = match.index + raw.length;
    }
    if (parts.length === 0) return text;
    parts.push(text.slice(lastEnd));
    return parts.join("");
  }

  /**
   * Redact transcript segments (the `transcript` field of `LocalMomentInput`).
   * Returns a shallow copy with redacted `text` fields. Originals are NOT mutated.
   */
  redactSegments<T extends { startMs: number; endMs: number; text: string }>(segments: readonly T[]): T[] {
    return segments.map((s) => ({ ...s, text: this.redactText(s.text).redacted }));
  }

  /**
   * Redact click element labels.
   * Returns a shallow copy with redacted `label` and `role` fields. Originals are NOT mutated.
   */
  redactClickLabels<T extends { time_ms: number; role: string | null; label: string | null }>(
    elements: readonly T[],
  ): T[] {
    return elements.map((el) => ({
      ...el,
      label: el.label ? this.redactText(el.label).redacted : el.label,
      role: el.role ? this.redactText(el.role).redacted : el.role,
    }));
  }

  /** Final summary. Never contains raw secret values. */
  get summary(): RedactionSummary {
    return {
      counts: { ...this.counts },
      placeholders: [...this.seen.values()],
    };
  }
}

// ---------------------------------------------------------------------------
// Safe custom regex compilation
// ---------------------------------------------------------------------------

/**
 * Try to compile a user-provided regex pattern. Returns the compiled RegExp
 * on success, or a safe error message on failure (never includes the raw
 * pattern in the error to avoid leaking input).
 */
export function compileCustomPattern(pattern: string, label: string): { pattern: RegExp; label: string } | { error: string } {
  if (!label || label.length > 40) {
    return { error: "Custom pattern label must be 1–40 characters." };
  }
  if (!/^[A-Z0-9_]+$/.test(label)) {
    return { error: "Custom pattern label must contain only A-Z, 0-9 and underscores." };
  }
  try {
    const re = new RegExp(pattern, "g");
    // Quick sanity: test against an empty string to catch catastrophic backtracking early
    re.exec("");
    return { pattern: re, label };
  } catch {
    return { error: `Custom redaction pattern at index for label "${label}" is not a valid regular expression.` };
  }
}
