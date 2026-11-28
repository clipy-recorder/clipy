import { describe, expect, it } from "vitest";
import {
  compileCustomPattern,
  REDACTION_CLASS_NAMES,
  RedactionSession,
} from "../src/index.js";

describe("RedactionSession — secret & PII classes", () => {
  it("redacts API keys across providers with deterministic indexed placeholders", () => {
    const session = new RedactionSession();
    const openAiKey = ["sk", "proj-abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const ghKey = ["ghp", "1234567890abcdefghijklmnopqrstuvwxyz"].join("_");
    const stripeKey = ["sk_live", "51AbCdEfGhIjKlMnOpQrStUvWxYz"].join("_");
    const slackKey = ["xoxb", "123456789012", "1234567890123", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-");

    const res1 = session.redactText(`Using ${openAiKey} and ${awsKey}`);
    expect(res1.redacted).toBe("Using [REDACTED_API_KEY_1] and [REDACTED_API_KEY_2]");
    expect(res1.count).toBe(2);

    // Repeating the same key reuses the same index
    const res2 = session.redactText(`Reusing ${openAiKey}, adding ${ghKey}, ${slackKey}, ${stripeKey}`);
    expect(res2.redacted).toBe(
      "Reusing [REDACTED_API_KEY_1], adding [REDACTED_API_KEY_3], [REDACTED_API_KEY_4], [REDACTED_API_KEY_5]",
    );
    expect(res2.summary.counts.apiKeys).toBe(5);
    expect(res2.summary.placeholders).not.toContain(openAiKey);
    expect(JSON.stringify(res2.summary)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts JWTs deterministically", () => {
    const session = new RedactionSession();
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const r = session.redactText(`User copied ${jwt} and got a 401; retried with ${jwt}`);
    expect(r.redacted).toBe("User copied [REDACTED_JWT_1] and got a 401; retried with [REDACTED_JWT_1]");
    expect(r.count).toBe(1);
    expect(r.summary.counts.jwt).toBe(1);
  });

  it("redacts PEM private key blocks", () => {
    const session = new RedactionSession();
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA123456\n-----END RSA PRIVATE KEY-----";
    const r = session.redactText(`Key:\n${pem}\nDone.`);
    expect(r.redacted).toBe("Key:\n[REDACTED_PRIVATE_KEY_1]\nDone.");
    expect(r.summary.counts.privateKeys).toBe(1);
  });

  it("redacts database connection strings", () => {
    const session = new RedactionSession();
    const pg = "postgres://admin:supersecret@db.internal:5432/prod";
    const mongo = "mongodb+srv://user:pass123@cluster0.example.net/mydb";
    const redis = "redis://:redispass@cache.internal:6379/0";
    const r = session.redactText(`Connect to ${pg}, ${mongo}, or ${redis}`);
    expect(r.redacted).toBe("Connect to [REDACTED_DB_URI_1], [REDACTED_DB_URI_2], or [REDACTED_DB_URI_3]");
    expect(r.summary.counts.connectionStrings).toBe(3);
  });

  it("redacts emails, public IPv4s, SSNs, phone numbers, and Luhn-valid credit cards", () => {
    const session = new RedactionSession();
    const text = [
      "Email: alice@example.com",
      "Server: 203.0.113.42",
      "SSN: 123-45-6789",
      "Phone: +44 20 7946 0958 and (415) 555-2671",
      "Card: 4532-0151-1283-0366",
    ].join(" | ");

    const r = session.redactText(text);
    expect(r.redacted).toBe(
      "Email: [REDACTED_EMAIL_1] | Server: [REDACTED_IP_1] | SSN: [REDACTED_SSN_1] | Phone: [REDACTED_PHONE_1] and [REDACTED_PHONE_2] | Card: [REDACTED_CC_1]",
    );
    expect(r.summary.counts).toEqual({
      emails: 1,
      ipAddresses: 1,
      ssns: 1,
      phoneNumbers: 2,
      creditCards: 1,
    });
  });

  it("rejects Luhn-invalid numbers as credit cards", () => {
    const session = new RedactionSession({ classes: ["creditCards"] });
    // Change last digit so Luhn fails
    const r = session.redactText("Order ID 4532-0151-1283-0367");
    expect(r.redacted).toBe("Order ID 4532-0151-1283-0367");
    expect(r.count).toBe(0);
  });
});

describe("RedactionSession — contextual Shannon entropy", () => {
  it("redacts high-entropy tokens preceded by secret-context keywords", () => {
    const session = new RedactionSession({ classes: ["highEntropy"] });
    const unknownSecret = "Xy9Kp2mQ8vL4nR7wZ1jF5tB3cH6dG0";
    const r = session.redactText(`Set bearer token = ${unknownSecret} in the header`);
    expect(r.redacted).toBe("Set bearer token = [REDACTED_SECRET_1] in the header");
    expect(r.summary.counts.highEntropy).toBe(1);
  });

  it("does not redact high-entropy strings without a secret-context keyword", () => {
    const session = new RedactionSession({ classes: ["highEntropy"] });
    const randomId = "Xy9Kp2mQ8vL4nR7wZ1jF5tB3cH6dG0";
    const r = session.redactText(`Look at component ${randomId} on the canvas`);
    expect(r.redacted).toBe(`Look at component ${randomId} on the canvas`);
    expect(r.count).toBe(0);
  });
});

describe("RedactionSession — false-positive resistance", () => {
  it("preserves git SHAs, UUIDs, loopback/bind IPs, TypeScript code, file paths, and timestamps", () => {
    const session = new RedactionSession();
    const samples = [
      "Commit 93cb6efe18208431cddfb8368fd83d5badbf9bfd fixed the bug",
      "token UUID 550e8400-e29b-41d4-a716-446655440000",
      "Listening on 127.0.0.1:8080 and 0.0.0.0:3000",
      "const res = await fetch('/api/v1/users', { method: 'POST' });",
      "File at C:\\Users\\adhir\\Projects\\clipy\\packages\\moments\\src\\index.ts",
      "Timestamp 2026-11-28T11:42:36+05:30 and 00:12:34.567",
    ];
    for (const sample of samples) {
      const r = session.redactText(sample);
      expect(r.redacted).toBe(sample);
      expect(r.count).toBe(0);
    }
  });
});

describe("RedactionSession — allowlist, class filtering & custom patterns", () => {
  it("respects allowlist entries", () => {
    const session = new RedactionSession({
      allowlist: ["support@clipy.online", "203.0.113.1"],
    });
    const r = session.redactText("Mail support@clipy.online or alice@example.com at 203.0.113.1");
    expect(r.redacted).toBe("Mail support@clipy.online or [REDACTED_EMAIL_1] at 203.0.113.1");
    expect(r.count).toBe(1);
  });

  it("restricts to configured classes", () => {
    const session = new RedactionSession({ classes: ["emails"] });
    const r = session.redactText("Email alice@example.com key sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(r.redacted).toBe("Email [REDACTED_EMAIL_1] key sk-proj-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("compiles valid custom patterns and rejects invalid ones without leaking raw regex", () => {
    const ok = compileCustomPattern("INTERNAL-[0-9]{4}", "TICKET");
    expect("pattern" in ok).toBe(true);
    if ("pattern" in ok) {
      const session = new RedactionSession({ classes: [], custom: [ok] });
      expect(session.redactText("See INTERNAL-4242").redacted).toBe("See [REDACTED_TICKET_1]");
    }

    const secretRegex = "[unclosed-secret-pattern(";
    const bad = compileCustomPattern(secretRegex, "MY_LABEL");
    expect("error" in bad).toBe(true);
    if ("error" in bad) {
      expect(bad.error).not.toContain(secretRegex);
      expect(bad.error).toContain("MY_LABEL");
    }

    const badLabel = compileCustomPattern("abc", "bad-label");
    expect("error" in badLabel).toBe(true);
  });

  it("redacts segments and click labels without mutating originals", () => {
    const session = new RedactionSession();
    const segments = [{ startMs: 0, endMs: 1000, text: "My key is sk-proj-abcdefghijklmnopqrstuvwxyz123456" }];
    const clicks = [{ time_ms: 500, role: "AXButton", label: "Send to alice@example.com" }];

    const outSegs = session.redactSegments(segments);
    const outClicks = session.redactClickLabels(clicks);

    expect(outSegs[0].text).toBe("My key is [REDACTED_API_KEY_1]");
    expect(outClicks[0].label).toBe("Send to [REDACTED_EMAIL_1]");
    expect(segments[0].text).toContain("sk-proj-");
    expect(clicks[0].label).toContain("alice@example.com");
    expect(REDACTION_CLASS_NAMES.length).toBeGreaterThanOrEqual(10);
  });

  it("handles pattern precedence overlaps cleanly (DB URI with embedded IP/key)", () => {
    const session = new RedactionSession();
    const uriWithIp = "postgres://user:pass@10.0.0.5:5432/db";
    const uriWithKey = "postgres://user:sk-proj-abcdefghijklmnopqrstuvwxyz123456@10.0.0.5/db";
    const r = session.redactText(`Connect ${uriWithIp} and ${uriWithKey}`);
    expect(r.redacted).toBe("Connect [REDACTED_DB_URI_1] and [REDACTED_DB_URI_2]");
    expect(r.summary.counts).toEqual({ connectionStrings: 2 });
  });

  it("handles empty strings, Unicode transcripts, and non-backtracking digit runs", () => {
    const session = new RedactionSession();
    expect(session.redactText("").redacted).toBe("");
    expect(session.redactText("").count).toBe(0);

    const unicode = "こんにちは alice@example.com 🚀";
    expect(session.redactText(unicode).redacted).toBe("こんにちは [REDACTED_EMAIL_1] 🚀");

    // Long non-matching digit/hyphen string must complete immediately without ReDoS
    const t0 = performance.now();
    const longDigits = `${"1111-".repeat(20)}1111x`;
    expect(session.redactText(longDigits).redacted).toBe(longDigits);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
