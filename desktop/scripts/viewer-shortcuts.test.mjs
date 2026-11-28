import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MOMENT_BACK_GRACE_MS,
  SEEK_STEP_MS,
  clampSeekMs,
  findAdjacentMomentMs,
  isTextInputTarget,
  resolveViewerShortcut,
} from "../src/lib/viewerShortcuts.ts";

test("resolveViewerShortcut handles playback, seek, moment, and help keys when unfocused", () => {
  assert.deepEqual(resolveViewerShortcut({ key: " ", code: "Space" }, { helpOpen: false }), {
    type: "togglePlay",
  });
  assert.deepEqual(resolveViewerShortcut({ key: "ArrowLeft" }, { helpOpen: false }), {
    type: "seekRelative",
    deltaMs: -SEEK_STEP_MS,
  });
  assert.deepEqual(resolveViewerShortcut({ key: "ArrowRight" }, { helpOpen: false }), {
    type: "seekRelative",
    deltaMs: SEEK_STEP_MS,
  });
  assert.deepEqual(resolveViewerShortcut({ key: "[" }, { helpOpen: false }), {
    type: "seekMoment",
    direction: -1,
  });
  assert.deepEqual(resolveViewerShortcut({ key: "]" }, { helpOpen: false }), {
    type: "seekMoment",
    direction: 1,
  });
  assert.deepEqual(resolveViewerShortcut({ key: "?", shiftKey: true }, { helpOpen: false }), {
    type: "toggleHelp",
  });
  assert.deepEqual(resolveViewerShortcut({ key: "Escape" }, { helpOpen: true }), {
    type: "closeHelp",
  });
  assert.equal(resolveViewerShortcut({ key: "Escape" }, { helpOpen: false }), null);
});

test("resolveViewerShortcut ignores shortcuts inside text fields and contenteditable targets", () => {
  const inputs = [
    { tagName: "INPUT" },
    { tagName: "textarea" },
    { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
    { tagName: "SPAN", closest: (sel) => (sel.includes("input") ? { tagName: "INPUT" } : null) },
  ];

  for (const target of inputs) {
    assert.equal(isTextInputTarget(target), true);
    for (const event of [
      { key: " ", code: "Space", target },
      { key: "ArrowLeft", target },
      { key: "ArrowRight", target },
      { key: "[", target },
      { key: "]", target },
      { key: "?", shiftKey: true, target },
      { key: "Escape", target },
    ]) {
      assert.equal(resolveViewerShortcut(event, { helpOpen: true }), null);
    }
  }
});

test("resolveViewerShortcut ignores modified shortcuts and already-prevented events", () => {
  assert.equal(resolveViewerShortcut({ key: " ", ctrlKey: true }, { helpOpen: false }), null);
  assert.equal(resolveViewerShortcut({ key: "ArrowLeft", metaKey: true }, { helpOpen: false }), null);
  assert.equal(resolveViewerShortcut({ key: "ArrowRight", altKey: true }, { helpOpen: false }), null);
  assert.equal(resolveViewerShortcut({ key: "ArrowLeft", shiftKey: true }, { helpOpen: false }), null);
  assert.equal(resolveViewerShortcut({ key: "[", defaultPrevented: true }, { helpOpen: false }), null);
});

test("resolveViewerShortcut lets UI action buttons handle Space while seek rows toggle play/pause", () => {
  const actionButton = { tagName: "BUTTON", dataset: {} };
  const seekButton = { tagName: "BUTTON", dataset: { viewerSeek: "true" } };
  const video = { tagName: "VIDEO" };

  assert.equal(resolveViewerShortcut({ key: " ", target: actionButton }, { helpOpen: false }), null);
  assert.deepEqual(resolveViewerShortcut({ key: " ", target: seekButton }, { helpOpen: false }), {
    type: "togglePlay",
  });
  assert.deepEqual(resolveViewerShortcut({ key: " ", target: video }, { helpOpen: false }), {
    type: "togglePlay",
  });
  assert.deepEqual(resolveViewerShortcut({ key: "[", target: actionButton }, { helpOpen: false }), {
    type: "seekMoment",
    direction: -1,
  });
});

test("clampSeekMs bounds positions cleanly within recording duration", () => {
  assert.equal(clampSeekMs(-2500, 12_000), 0);
  assert.equal(clampSeekMs(5000, 12_000), 5000);
  assert.equal(clampSeekMs(17_000, 12_000), 12_000);
  assert.equal(clampSeekMs(Number.NaN, 12_000), 0);
  assert.equal(clampSeekMs(5000, 0), 0);
});

test("findAdjacentMomentMs steps cleanly across sorted, unsorted, and duplicate moments", () => {
  const moments = [15_000, 2_000, 8_000, 8_000];

  assert.equal(findAdjacentMomentMs([], 5000, 1), null);
  assert.equal(findAdjacentMomentMs(moments, 0, -1), null);
  assert.equal(findAdjacentMomentMs(moments, 0, 1), 2_000);
  assert.equal(findAdjacentMomentMs(moments, 2_000, -1), null);
  assert.equal(findAdjacentMomentMs(moments, 2_000, 1), 8_000);
  assert.equal(findAdjacentMomentMs(moments, 8_000, -1), 2_000);
  assert.equal(findAdjacentMomentMs(moments, 8_000, 1), 15_000);
  assert.equal(findAdjacentMomentMs(moments, 10_000, -1), 8_000);
  assert.equal(findAdjacentMomentMs(moments, 10_000, 1), 15_000);
  assert.equal(findAdjacentMomentMs(moments, 15_000, 1), null);
  assert.equal(findAdjacentMomentMs(moments, 18_000, -1), 15_000);
});

test("findAdjacentMomentMs uses grace window when playing so pressing [ does not stall on the current moment", () => {
  const moments = [2_000, 7_500, 8_000, 15_000];

  // Just passed 8000 while playing -> step back to 7500 without skipping it.
  assert.equal(findAdjacentMomentMs(moments, 8_250, -1, MOMENT_BACK_GRACE_MS), 7_500);
  // Well past 8000 -> jump back to 8000.
  assert.equal(findAdjacentMomentMs(moments, 10_000, -1, MOMENT_BACK_GRACE_MS), 8_000);
});
