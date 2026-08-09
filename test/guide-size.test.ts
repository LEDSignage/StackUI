/**
 * The guide-frame size workaround.
 *
 * ComfyUI builds MiniMaxH3ImageToVideo's latent with `height // 16` and pads
 * that to the patch size, but encodes the start frame with no padding at all.
 * Where `size / 16` is odd the two disagree and the run dies in a reshape. So
 * the job is submitted at the next multiple of 32 and the file is cropped back
 * afterwards — see /api/fit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixGuideSize } from '../shared/guideSize.ts';
import type { ApiPrompt } from '../shared/types.ts';

const graph = (inputs: Record<string, unknown>): ApiPrompt => ({
  '6': { class_type: 'MiniMaxH3ImageToVideo', inputs: { width: 1920, height: 1080, ...inputs } },
  '9': { class_type: 'BasicScheduler', inputs: { steps: 20 } },
});

test('1920x1080 with a start frame goes out at 1920x1088', () => {
  const g = graph({ first_frame: ['5', 0] });
  const fix = fixGuideSize(g);

  assert.deepEqual(fix, { width: 1920, height: 1080, sentWidth: 1920, sentHeight: 1088 });
  assert.equal(g['6']!.inputs.height, 1088, 'the prompt is rewritten');
  assert.equal(g['6']!.inputs.width, 1920, 'a width already on the grid is left alone');
});

test('the submitted size always divides by 32', () => {
  for (const [w, h] of [
    [1920, 1080],
    [720, 1280],
    [1071, 1428],
    [1920, 172],
    [650, 900],
  ] as const) {
    const g = graph({ width: w, height: h, first_frame: ['5', 0] });
    const fix = fixGuideSize(g);
    const sentW = fix?.sentWidth ?? w;
    const sentH = fix?.sentHeight ?? h;
    assert.equal(sentW % 32, 0, `${w}x${h}: width`);
    assert.equal(sentH % 32, 0, `${w}x${h}: height`);
    assert.ok(sentW >= w && sentH >= h, `${w}x${h}: never smaller than asked for`);
    assert.ok(sentW - w < 32 && sentH - h < 32, `${w}x${h}: never more than a step larger`);
  }
});

test('a size already on the grid is left completely alone', () => {
  const g = graph({ width: 1344, height: 768, first_frame: ['5', 0] });
  assert.equal(fixGuideSize(g), null);
  assert.equal(g['6']!.inputs.height, 768);
});

test('without a guide frame nothing is touched', () => {
  // No start or end frame means the crashing code never runs, so rounding
  // would change the output for no reason at all.
  const g = graph({});
  assert.equal(fixGuideSize(g), null);
  assert.equal(g['6']!.inputs.height, 1080);
});

test('an end frame alone still counts', () => {
  const g = graph({ last_frame: ['5', 0] });
  assert.equal(fixGuideSize(g)?.sentHeight, 1088);
});

test('other node types are ignored', () => {
  const g: ApiPrompt = {
    '1': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { width: 1920, height: 172 } },
    '2': { class_type: 'EmptyLatentImage', inputs: { width: 1080, height: 1080 } },
  };
  assert.equal(fixGuideSize(g), null);
  assert.equal(g['1']!.inputs.height, 172, 'the reference node adapts its own canvas');
});
