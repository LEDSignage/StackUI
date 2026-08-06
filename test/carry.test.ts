/**
 * Switching model within a job carries your settings across.
 *
 * The two H3 modes are two stacks because they need different weights and a
 * different node, but that must not be visible as "your prompt vanished".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryControls } from '../web/src/lib/stackOps.ts';
import { SCHEMA_VERSION, type Stack } from '../shared/types.ts';

const stack = (id: string, over: Partial<Stack> = {}): Stack => ({
  schemaVersion: SCHEMA_VERSION,
  id,
  name: 'Make a video',
  job: 'Make a video',
  lines: [],
  ...over,
});

/** Two pages for one job: same labels, different tiles underneath. */
function pair() {
  const from = stack('a', {
    controls: [
      { label: 'Width', tileId: 't-one', param: 'width' },
      { label: 'Height', tileId: 't-one', param: 'height' },
      { label: 'Seed', tileId: 't-noise', param: 'noise_seed' },
      { label: 'Seconds', tileId: 't-one', param: 'length', seconds: { fps: 24, step: 17, offset: 5 } },
      { label: 'Start frame', tileId: 't-img', param: 'image' },
    ],
    lines: [
      {
        id: 'l1',
        mode: 'parallel',
        bypassed: false,
        tiles: [
          { id: 't-one', moduleId: 'm', params: { width: 1920, height: 1080, length: 124 }, collapsed: true },
          { id: 't-noise', moduleId: 'n', params: { noise_seed: 99 }, collapsed: true },
          { id: 't-img', moduleId: 'i', params: { image: 'start.png' }, collapsed: true },
        ],
      },
    ],
  });

  const to = stack('b', {
    controls: [
      { label: 'Width', tileId: 't-two', param: 'width' },
      { label: 'Height', tileId: 't-two', param: 'height' },
      { label: 'Seed', tileId: 't-rand', param: 'noise_seed' },
      { label: 'Seconds', tileId: 't-two', param: 'length', seconds: { fps: 25, step: 8, offset: 1 } },
    ],
    lines: [
      {
        id: 'l1',
        mode: 'parallel',
        bypassed: false,
        tiles: [
          { id: 't-two', moduleId: 'm', params: { width: 832, height: 480, length: 97 }, collapsed: true },
          { id: 't-rand', moduleId: 'n', params: { noise_seed: 1 }, collapsed: true },
        ],
      },
    ],
  });

  return { from, to };
}

const paramOf = (s: Stack, tileId: string, name: string) =>
  s.lines.flatMap((l) => l.tiles).find((t) => t.id === tileId)?.params[name];

test('matching controls carry across, onto the destination’s own tiles', () => {
  const { from, to } = pair();
  const out = carryControls(from, to);
  assert.equal(paramOf(out, 't-two', 'width'), 1920);
  assert.equal(paramOf(out, 't-two', 'height'), 1080);
  assert.equal(paramOf(out, 't-rand', 'noise_seed'), 99);
});

test('a duration does not carry — the frame grids differ', () => {
  // 124 frames is legal on H3's 17n+5 grid and illegal on LTX's 8n+1. Copying
  // the raw number would produce a length neither model accepts.
  const { from, to } = pair();
  const out = carryControls(from, to);
  assert.equal(paramOf(out, 't-two', 'length'), 97, 'destination keeps its own valid length');
});

test('a control the destination does not have is dropped, not invented', () => {
  const { from, to } = pair();
  const out = carryControls(from, to);
  assert.equal(
    out.lines.flatMap((l) => l.tiles).some((t) => t.id === 't-img'),
    false,
    'no start-frame tile appears on a page that has no start frame',
  );
});

test('the shot list carries, retargeted at the new prompt param', () => {
  const script = {
    target: { tileId: 't-one', param: 'prompt' },
    vision: 'Warm light.',
    shots: [{ from: 0, to: 2, text: 'The sign.' }],
  };
  const { from, to } = pair();
  const out = carryControls({ ...from, script }, { ...to, script: { ...script, target: { tileId: 't-two', param: 'prompt' } } });
  assert.equal(out.script?.vision, 'Warm light.');
  assert.equal(out.script?.shots.length, 1);
  assert.equal(out.script?.target.tileId, 't-two', 'retargeted at the destination');
});

test('nothing is carried when either side declares no controls', () => {
  const { from, to } = pair();
  assert.deepEqual(carryControls(stack('x'), to), to);
  assert.deepEqual(carryControls(from, stack('y')), stack('y'));
});
