import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  firstEnabledIndex,
  initialListboxIndex,
  lastEnabledIndex,
  nextEnabledIndex,
} from "../src/lib/listboxNavigation.ts";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));

test("firstEnabledIndex and lastEnabledIndex skip disabled options", () => {
  const items = [{ disabled: true }, { disabled: false }, { disabled: true }, {}, { disabled: true }];
  assert.equal(firstEnabledIndex(items), 1);
  assert.equal(lastEnabledIndex(items), 3);
  assert.equal(firstEnabledIndex([{ disabled: true }, { disabled: true }]), -1);
  assert.equal(lastEnabledIndex([{ disabled: true }, { disabled: true }]), -1);
});

test("initialListboxIndex prefers selected enabled item and falls back cleanly", () => {
  const items = [{ disabled: true }, { disabled: false }, { disabled: false }, { disabled: true }];
  assert.equal(initialListboxIndex(items, 2), 2);
  assert.equal(initialListboxIndex(items, 0, "start"), 1);
  assert.equal(initialListboxIndex(items, 0, "end"), 2);
  assert.equal(initialListboxIndex(items, -1, "start"), 1);
  assert.equal(initialListboxIndex(items, -1, "end"), 2);
});

test("nextEnabledIndex navigates around disabled items and clamps or wraps", () => {
  const items = [{}, { disabled: true }, {}, { disabled: true }];
  // Non-wrapping (InlineSelect listbox): stops at boundaries and skips disabled items.
  assert.equal(nextEnabledIndex(items, 0, 1), 2);
  assert.equal(nextEnabledIndex(items, 2, 1), 2);
  assert.equal(nextEnabledIndex(items, 2, -1), 0);
  assert.equal(nextEnabledIndex(items, 0, -1), 0);

  // Wrapping (Tabs tablist): wraps cleanly between first and last enabled items.
  assert.equal(nextEnabledIndex(items, 2, 1, { wrap: true }), 0);
  assert.equal(nextEnabledIndex(items, 0, -1, { wrap: true }), 2);
  assert.equal(nextEnabledIndex([], 0, 1, { wrap: true }), -1);
});

test("ui.tsx and LocalPreferences.tsx maintain keyboard and screen-reader attributes", () => {
  const ui = readFileSync(path.join(desktopDir, "src/components/recorder/ui.tsx"), "utf8");
  const prefs = readFileSync(path.join(desktopDir, "src/edition-local/LocalPreferences.tsx"), "utf8");

  assert.match(ui, /<h2 className=.*>\{children\}<\/h2>/);
  assert.match(ui, /aria-controls=\{open \? listboxId : undefined\}/);
  assert.match(ui, /role="listbox"\s+aria-label=\{ariaLabel\}/);
  assert.match(ui, /aria-describedby=\{row\?\.subtitleId\}/);
  assert.match(ui, /tone === "error" \? "alert" : tone === "info" \? "note" : "status"/);

  assert.match(prefs, /aria-label=\{`Replace \$\{label\}`\}/);
  assert.match(prefs, /aria-label=\{`Keep saved \$\{label\}`\}/);
  assert.match(prefs, /aria-label="Save moment selection"/);
  assert.match(prefs, /aria-label="Save transcription settings"/);
  assert.match(prefs, /role="progressbar"/);
  assert.match(prefs, /aria-valuenow=\{percent\}/);
});
