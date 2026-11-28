/**
 * Deterministic regex patterns for secret and PII detection.
 *
 * Every pattern is a pure RegExp with the global flag. Each class has a label
 * used in indexed placeholders (`[REDACTED_API_KEY_1]`). No dependencies.
 */

/** A single redaction pattern class. */
export interface PatternClass {
  /** The class name, used in config and summaries. */
  name: RedactionClassName;
  /** Human-readable label for placeholders, e.g. "API_KEY". */
  label: string;
  /** One or more regexes (applied in order). Must have the `g` flag. */
  patterns: RegExp[];
}

export const REDACTION_CLASS_NAMES = [
  "apiKeys",
  "jwt",
  "privateKeys",
  "connectionStrings",
  "emails",
  "ipAddresses",
  "creditCards",
  "ssns",
  "phoneNumbers",
  "highEntropy",
] as const;

export type RedactionClassName = (typeof REDACTION_CLASS_NAMES)[number];

// ---------------------------------------------------------------------------
// API key patterns — vendor prefixed, plus generic long-prefix keys
// ---------------------------------------------------------------------------

const API_KEY_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic: sk-... (at least 20 chars after prefix)
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // OpenRouter: sk-or-v1-...
  /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/g,
  // AWS Access Key: AKIA followed by 16 uppercase alphanum
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // GitLab: glpat-...
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  // Google: AIza...
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  // Slack: xoxb-, xoxp-, xoxo-, xoxa-, xoxs-
  /\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/g,
  // Stripe: sk_live_, rk_live_, sk_test_, rk_test_
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  // Groq: gsk_...
  /\bgsk_[A-Za-z0-9]{20,}\b/g,
  // Twilio: SK followed by 32 hex chars
  /\bSK[0-9a-f]{32}\b/g,
  // SendGrid: SG....
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  // npm tokens: npm_...
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  // Heroku: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} is a UUID, skip — handled by allowlist
  // Vercel: bearer tokens starting with specific prefixes are caught by highEntropy
];

// ---------------------------------------------------------------------------
// JWT: three base64url segments separated by dots
// ---------------------------------------------------------------------------

const JWT_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

// ---------------------------------------------------------------------------
// PEM private key blocks
// ---------------------------------------------------------------------------

const PRIVATE_KEY_PATTERNS: RegExp[] = [
  /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g,
];

// ---------------------------------------------------------------------------
// Connection strings with embedded credentials
// ---------------------------------------------------------------------------

const CONNECTION_STRING_PATTERNS: RegExp[] = [
  // postgres://, postgresql://, mysql://, mongodb+srv://, mongodb://, redis://, rediss://, amqp://, amqps://
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s"'`,;)]+/g,
];

// ---------------------------------------------------------------------------
// Email addresses (RFC 5322 lite)
// ---------------------------------------------------------------------------

const EMAIL_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

// ---------------------------------------------------------------------------
// IPv4 addresses (non-loopback, non-link-local, non-broadcast)
// ---------------------------------------------------------------------------

const IPV4_PATTERNS: RegExp[] = [
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
];

/** IPs that should NOT be redacted. */
const SAFE_IPS = new Set([
  "127.0.0.1",
  "0.0.0.0",
  "255.255.255.255",
  "169.254.0.0",
  "224.0.0.0",
  "10.0.0.0",
]);

/** Loopback (127.x.x.x), link-local (169.254.x.x), or other safe IPs. */
export function isSafeIP(ip: string): boolean {
  if (SAFE_IPS.has(ip)) return true;
  if (ip.startsWith("127.")) return true;
  if (ip.startsWith("169.254.")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Credit card numbers with optional separators, validated with Luhn
// ---------------------------------------------------------------------------

const CREDIT_CARD_PATTERNS: RegExp[] = [
  /\b\d(?:[ -]?\d){12,18}\b/g,
];

/** Luhn check on a string of digits. */
export function isLuhnValid(digits: string): boolean {
  const nums = digits.replace(/\D/g, "");
  if (nums.length < 13 || nums.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = Number(nums[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// US Social Security Numbers
// ---------------------------------------------------------------------------

const SSN_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

// ---------------------------------------------------------------------------
// Phone numbers (E.164 and North American)
// ---------------------------------------------------------------------------

const PHONE_PATTERNS: RegExp[] = [
  // E.164: +1... to +999... (at least 10 digits total)
  /\+\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{2,9}\b/g,
  // North American: (xxx) xxx-xxxx or xxx-xxx-xxxx or xxx.xxx.xxxx
  /(?:\(\d{3}\)|\b\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g,
];

// ---------------------------------------------------------------------------
// High-entropy contextual fallback
// ---------------------------------------------------------------------------

/**
 * Shannon entropy of a string, in bits per character.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let ent = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    ent -= p * Math.log2(p);
  }
  return ent;
}

/** Keywords that precede a high-entropy token suggesting it's a secret. */
const SECRET_CONTEXT_KEYWORDS = /\b(?:token|secret|key|password|passwd|pwd|auth|bearer|apikey|api_key|api-key|credentials?|private_key|access_token|refresh_token)\b/i;

/**
 * Matches a high-entropy token only when preceded by a secret-context keyword.
 * The lookahead/behind approach doesn't work with JS regex globally, so we do
 * it in the matching function (see `applyHighEntropy` in `index.ts`).
 */
export const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9_/+=-]{20,}/g;
export const HIGH_ENTROPY_MIN_BITS = 4.2;
export { SECRET_CONTEXT_KEYWORDS };

// ---------------------------------------------------------------------------
// Assembled pattern classes
// ---------------------------------------------------------------------------

export const PATTERN_CLASSES: PatternClass[] = [
  // Broader/structural secrets first so embedded IPs, emails, or keys aren't partially mangled
  { name: "privateKeys", label: "PRIVATE_KEY", patterns: PRIVATE_KEY_PATTERNS },
  { name: "connectionStrings", label: "DB_URI", patterns: CONNECTION_STRING_PATTERNS },
  { name: "jwt", label: "JWT", patterns: JWT_PATTERNS },
  { name: "apiKeys", label: "API_KEY", patterns: API_KEY_PATTERNS },
  { name: "emails", label: "EMAIL", patterns: EMAIL_PATTERNS },
  { name: "ipAddresses", label: "IP", patterns: IPV4_PATTERNS },
  { name: "creditCards", label: "CC", patterns: CREDIT_CARD_PATTERNS },
  { name: "ssns", label: "SSN", patterns: SSN_PATTERNS },
  { name: "phoneNumbers", label: "PHONE", patterns: PHONE_PATTERNS },
  // highEntropy is handled specially in the redaction engine
  { name: "highEntropy", label: "SECRET", patterns: [] },
];
