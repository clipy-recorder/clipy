import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampPoint,
  isUsableSelection,
  moveRect,
  rectFromPoints,
  resizeRect,
  type Bounds,
  type Point,
  type Rect,
} from "../src/lib/areaSelectGeometry.ts";

test("clampPoint keeps points within bounds", () => {
  const bounds: Bounds = { width: 1920, height: 1080 };
  assert.deepEqual(clampPoint({ x: -10, y: -5 }, bounds), { x: 0, y: 0 });
  assert.deepEqual(clampPoint({ x: 500, y: 600 }, bounds), { x: 500, y: 600 });
  assert.deepEqual(clampPoint({ x: 2500, y: 1500 }, bounds), { x: 1920, y: 1080 });
});

test("rectFromPoints normalizes inverted drag directions", () => {
  const a: Point = { x: 100, y: 100 };
  const b: Point = { x: 20, y: 40 };
  assert.deepEqual(rectFromPoints(a, b), { x: 20, y: 40, width: 80, height: 60 });
});

test("isUsableSelection rejects tiny boxes", () => {
  assert.equal(isUsableSelection({ x: 0, y: 0, width: 7, height: 20 }), false);
  assert.equal(isUsableSelection({ x: 0, y: 0, width: 20, height: 7 }), false);
  assert.equal(isUsableSelection({ x: 0, y: 0, width: 8, height: 8 }), true);
});

test("moveRect shifts rect without exceeding bounds", () => {
  const bounds: Bounds = { width: 1000, height: 800 };
  const start: Rect = { x: 100, y: 100, width: 200, height: 150 };
  // Normal shift
  assert.deepEqual(moveRect(start, { x: 50, y: 30 }, bounds), {
    x: 150,
    y: 130,
    width: 200,
    height: 150,
  });
  // Bound limit on right/bottom
  assert.deepEqual(moveRect(start, { x: 1000, y: 1000 }, bounds), {
    x: 800,
    y: 650,
    width: 200,
    height: 150,
  });
  // Bound limit on left/top
  assert.deepEqual(moveRect(start, { x: -300, y: -300 }, bounds), {
    x: 0,
    y: 0,
    width: 200,
    height: 150,
  });
});

test("resizeRect drags edges and corners correctly", () => {
  const bounds: Bounds = { width: 1000, height: 800 };
  const start: Rect = { x: 100, y: 100, width: 200, height: 150 };

  // Drag southeast handle by delta +50, +50
  const se = resizeRect(start, "se", { x: 50, y: 50 }, bounds);
  assert.deepEqual(se, { x: 100, y: 100, width: 250, height: 200 });

  // Drag northwest handle by delta -50, -40
  const nw = resizeRect(start, "nw", { x: -50, y: -40 }, bounds);
  assert.deepEqual(nw, { x: 50, y: 60, width: 250, height: 190 });

  // Dragging past minimum size enforces minimum width/height
  const collapsed = resizeRect(start, "se", { x: -250, y: -200 }, bounds);
  assert.equal(collapsed.width, 8);
  assert.equal(collapsed.height, 8);
});
