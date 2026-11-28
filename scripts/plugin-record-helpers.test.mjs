#!/usr/bin/env node
/**
 * Pure-function tests for the Record button plugin's helpers.
 *
 * The full test suite (plugins/clipy-record/hooks/register.test.tsx) uses
 * claude-code/testing and needs `claude plugin test` with a signed-in
 * session. This file covers the exported pure helpers so CI can catch
 * regressions without Claude Code.
 *
 * Where possible, functions are imported directly from the production .ts
 * modules (display.ts, cloud.ts, signin.ts) using a custom loader that
 * resolves extensionless imports and stubs the claude-code package.
 *
 * register.tsx cannot be imported directly because it contains JSX that
 * Node's type stripping does not transform. Its pure helpers (clock,
 * splitCommand, isOlder, parse) are re-implemented here with a source
 * hash check that fails when the original changes.
 *
 * Run with:
 *   node --experimental-transform-types \
 *        --loader ./scripts/plugin-test-loader.mjs \
 *        --test scripts/plugin-record-helpers.test.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Direct imports from production .ts modules (via the custom loader)
// ---------------------------------------------------------------------------

import {
  nameFromFind,
  nameFromInfo,
  pickDisplay,
} from "../plugins/clipy-record/hooks/display.ts";

import {
  newestOf,
  isoFromHttpDate,
  isNewer,
  isReadable,
  cloudPrompt,
} from "../plugins/clipy-record/hooks/cloud.ts";

import { confirmationCode } from "../plugins/clipy-record/hooks/signin.ts";

// ---------------------------------------------------------------------------
// register.tsx helpers: re-implemented because the .tsx file contains JSX
// that Node cannot parse. A hash of the source lines anchors each copy to
// the original so the test fails when the production code changes.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER_SRC = readFileSync(
  join(ROOT, "plugins/clipy-record/hooks/register.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

/**
 * Hash the lines of register.tsx that define a function, so the test breaks
 * if the production code is edited without updating the copy here.
 */
function sourceHash(startMarker, endMarker) {
  const start = REGISTER_SRC.indexOf(startMarker);
  const end = REGISTER_SRC.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find "${startMarker}" in register.tsx`);
  }
  const slice = REGISTER_SRC.slice(start, end).replace(/\s+/g, " ");
  return createHash("sha256").update(slice).digest("hex").slice(0, 16);
}

// -- clock (line ~757) --
const CLOCK_HASH = sourceHash(
  "export function clock(",
  "\n\nasync function setDestination"
);
assert.equal(
  CLOCK_HASH,
  "4e0bba5ca5f6bdcd",
  "register.tsx clock() source changed — update the re-implementation in this test and recompute the hash"
);

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// -- splitCommand (line ~80) --
const SPLIT_HASH = sourceHash(
  "export function splitCommand(",
  "\n\nconst quote ="
);
assert.equal(
  SPLIT_HASH,
  "23bf144de721cec4",
  "register.tsx splitCommand() source changed — update the re-implementation in this test and recompute the hash"
);

function splitCommand(command) {
  const args = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

// -- isOlder (line ~65) --
const OLDER_HASH = sourceHash(
  "export function isOlder(",
  "\n\n/**\n * Splits the configured"
);
assert.equal(
  OLDER_HASH,
  "564dbb479b89f9a7",
  "register.tsx isOlder() source changed — update the re-implementation in this test and recompute the hash"
);

function versionOf(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function isOlder(version, than) {
  const a = versionOf(version);
  const b = versionOf(than);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

// -- parse (line ~111) --
const PARSE_HASH = sourceHash(
  "export function parse(run",
  "\n\n/** "
);
assert.equal(
  PARSE_HASH,
  "bdc9da171933a374",
  "register.tsx parse() source changed — update the re-implementation in this test and recompute the hash"
);

function parse(run) {
  const text = run.stdout.trim();
  const start = text.indexOf("{");
  let json = null;
  if (start !== -1) {
    try {
      json = JSON.parse(text.slice(start));
    } catch {
      json = null;
    }
  }
  if (run.exitCode === 0 && json) return { json, error: "" };
  const said =
    typeof json?.error === "string"
      ? json.error
      : typeof json?.message === "string"
        ? json.message
        : "";
  const lines = (json ? run.stderr : `${run.stderr}\n${run.stdout}`)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line =
    said ||
    lines.find((l) => /^error:/i.test(l)) ||
    lines.at(-1) ||
    "clipy failed";
  return { json, error: line.replace(/^error:\s*/i, "") };
}

// ---------------------------------------------------------------------------
// Tests — same assertions as plugins/clipy-record/hooks/register.test.tsx
// ---------------------------------------------------------------------------

const SCREENS = {
  displays: [
    { id: 1, x: 0, y: 0, width: 1920, height: 1080 },
    { id: 3, x: -1920, y: -1080, width: 1920, height: 1080 },
    { id: 4, x: 1920, y: 0, width: 1440, height: 900 },
  ],
  windows: [
    { app_name: "Claude", x: 100, y: 100, width: 800, height: 600 },
    { app_name: "\u200EWhatsApp", x: 2000, y: 100, width: 500, height: 400 },
  ],
};

describe("display.ts (production import)", () => {
  it("nameFromFind extracts app name", () => {
    assert.equal(nameFromFind('ASN:0x0-0x392d92a-"Claude":\n'), "Claude");
    assert.equal(nameFromFind(""), null);
  });

  it("nameFromInfo extracts app name", () => {
    assert.equal(
      nameFromInfo(
        '"iTerm2" ASN:0x0-0x16e16e0: (in front)\n    bundleID=[ NULL ]'
      ),
      "iTerm2"
    );
  });

  it("pickDisplay finds the screen by window centre", () => {
    assert.equal(pickDisplay(SCREENS, "Claude"), 1);
    assert.equal(pickDisplay(SCREENS, "WhatsApp"), 4);
  });

  it("pickDisplay by overlap for straddling windows", () => {
    assert.equal(
      pickDisplay(
        {
          ...SCREENS,
          windows: [
            { app_name: "iTerm2", x: -400, y: -900, width: 1000, height: 600 },
          ],
        },
        "iTerm2"
      ),
      3
    );
  });

  it("pickDisplay returns null with one screen or no window", () => {
    assert.equal(
      pickDisplay({ ...SCREENS, displays: [SCREENS.displays[0]] }, "Claude"),
      null
    );
    assert.equal(pickDisplay(SCREENS, "Cursor"), null);
  });
});

describe("cloud.ts (production import)", () => {
  it("newestOf parses a recording", () => {
    const r = newestOf(
      JSON.stringify({
        recordings: [
          {
            id: "v1",
            createdAt: "2026-01-01T00:00:00Z",
            stage: "ready",
            agentReadiness: "complete",
          },
        ],
      })
    );
    assert.equal(r.id, "v1");
    assert.equal(r.readiness, "complete");
    assert.equal(newestOf("{}"), null);
    assert.equal(newestOf("not json"), null);
  });

  it("isoFromHttpDate converts HTTP dates", () => {
    assert.equal(
      isoFromHttpDate("Thu, 01 Jan 2026 00:00:00 GMT"),
      "2026-01-01T00:00:00.000Z"
    );
    assert.equal(isoFromHttpDate(undefined), null);
    assert.equal(isoFromHttpDate("not a date"), null);
  });

  it("isNewer detects recordings after baseline", () => {
    const rec = (id, at) => ({
      id,
      createdAt: at,
      stage: "ready",
      readiness: "complete",
    });
    assert.equal(isNewer(rec("b", "2026-01-02"), "a", "2026-01-01"), true);
    assert.equal(isNewer(rec("a", "2026-01-01"), "a", "2026-01-01"), false);
  });

  it("isReadable marks usable/complete/failed as readable", () => {
    assert.equal(
      isReadable({ id: "1", createdAt: "", stage: "ready", readiness: "usable" }),
      true
    );
    assert.equal(
      isReadable({ id: "1", createdAt: "", stage: "uploading", readiness: "preparing" }),
      false
    );
  });

  it("cloudPrompt includes the video id", () => {
    assert.ok(cloudPrompt("test-id").includes("clipy.online/video/test-id"));
  });
});

describe("signin.ts (production import)", () => {
  it("confirmationCode matches clipy.online", async () => {
    assert.equal(
      await confirmationCode("VUjza-715nZd22cDut-6X__MMgZ8B9E2MP8fvGp1CSI"),
      "7GV8-VNDY"
    );
  });
});

describe("register.tsx helpers (re-implemented, hash-verified)", () => {
  it("clock formats seconds as m:ss", () => {
    assert.equal(clock(5), "0:05");
    assert.equal(clock(65), "1:05");
    assert.equal(clock(600), "10:00");
    assert.equal(clock(0), "0:00");
  });

  it("splitCommand keeps quoted paths together", () => {
    assert.deepEqual(
      splitCommand('node "D:\\Clipy Tools\\cli\\index.js"'),
      ["node", "D:\\Clipy Tools\\cli\\index.js"]
    );
    assert.deepEqual(
      splitCommand("  /usr/bin/node '/opt/Clipy Tools/cli.js'  "),
      ["/usr/bin/node", "/opt/Clipy Tools/cli.js"]
    );
    assert.deepEqual(splitCommand("clipy"), ["clipy"]);
    assert.deepEqual(splitCommand('node ""'), ["node", ""]);
  });

  it("isOlder compares semver strings", () => {
    assert.equal(isOlder("0.13.1", "0.14.0"), true);
    assert.equal(isOlder("0.20.0", "0.14.0"), false);
    assert.equal(isOlder("1.0.0", "1.0.0"), false);
    assert.equal(isOlder("nope", "0.0.1"), true);
  });

  it("parse extracts JSON and error from CLI output", () => {
    const ok = parse({
      exitCode: 0,
      stdout: '{"state":"recording"}',
      stderr: "",
    });
    assert.deepEqual(ok.json, { state: "recording" });
    assert.equal(ok.error, "");

    const fail = parse({
      exitCode: 1,
      stdout: "",
      stderr: "error: bridge timed out\n",
    });
    assert.equal(fail.json, null);
    assert.equal(fail.error, "bridge timed out");

    const empty = parse({ exitCode: 1, stdout: "", stderr: "" });
    assert.equal(empty.error, "clipy failed");
  });
});

// A canary that can be broken to verify CI fails:
describe("canary", () => {
  it("1 + 1 = 2", () => {
    assert.equal(1 + 1, 2);
  });
});
