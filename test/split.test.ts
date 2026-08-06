/**
 * The divider's travel limit.
 *
 * It is a limit on movement either side of centre, not a minimum measured from
 * the edges of the screen — those are the same thing only on a 1000px window,
 * and on a wide monitor an edge-based floor lets the divider swing almost the
 * whole width, which is not what a limit is for.
 *
 * The clamp is duplicated here rather than imported, because the hook it lives
 * in needs a DOM. Keep the two in step.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const RANGE = 250;

/** Where the divider ends up, given the container width and the pointer. */
function clamp(containerWidth: number, pointerX: number): number {
  const centre = containerWidth / 2;
  const lo = Math.max(120, centre - RANGE);
  const hi = Math.min(containerWidth - 120, centre + RANGE);
  return Math.max(lo, Math.min(hi, pointerX));
}

test('it travels 250px either side of centre, not of the edges', () => {
  const w = 2560;
  assert.equal(clamp(w, 1280), 1280, 'centre is centre');
  assert.equal(clamp(w, 1030), 1030, 'full travel left');
  assert.equal(clamp(w, 1530), 1530, 'full travel right');
  assert.equal(clamp(w, 0), 1030, 'dragged to the left edge, stops at the limit');
  assert.equal(clamp(w, 5000), 1530, 'dragged off the right, stops at the limit');
});

test('the range is the same on any width', () => {
  for (const w of [1200, 1920, 2560, 3840]) {
    assert.equal(clamp(w, -1) - w / 2, -RANGE, `${w}px: left limit`);
    assert.equal(clamp(w, w * 2) - w / 2, RANGE, `${w}px: right limit`);
  }
});

test('a window narrower than the range still leaves both columns visible', () => {
  const w = 900; // half is 450, less than RANGE
  assert.ok(clamp(w, 0) >= 120, 'the left column keeps some width');
  assert.ok(clamp(w, 9999) <= w - 120, 'and so does the right');
});
