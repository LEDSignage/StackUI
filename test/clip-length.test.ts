/**
 * The clip is as long as the shot list.
 *
 * Two places used to say how long the video was — the Seconds box and the end
 * of the last shot — with nothing reconciling them. A five second shot list in
 * a ten second clip left the model five seconds to invent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncClipLength, findTile, secondsControl } from '../web/src/lib/stackOps.ts';
import { migrate } from '../shared/migrate.ts';
import type { Module, ModuleLibrary, Script, Stack } from '../shared/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function library(dir = join(ROOT, 'modules'), lib: ModuleLibrary = {}): ModuleLibrary {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) library(full, lib);
    else if (entry.name.endsWith('.json')) {
      const m = JSON.parse(readFileSync(full, 'utf8')) as Module;
      lib[m.id] = m;
    }
  }
  return lib;
}

const LIB = library();
const load = (id: string): Stack =>
  migrate(JSON.parse(readFileSync(join(ROOT, 'stacks', `${id}.json`), 'utf8')));

const withShots = (stack: Stack, shots: [number, number][]): Stack => ({
  ...stack,
  script: { ...(stack.script as Script), shots: shots.map(([from, to]) => ({ from, to, text: 'x' })) },
});

/** The frames the length control ended up holding. */
function frames(stack: Stack): number {
  const c = secondsControl(stack)!;
  return Number(findTile(stack, c.tileId)!.params[c.param]);
}

test('H3: the clip matches the shots, snapped to its 17n+5 grid', () => {
  const out = syncClipLength(withShots(load('video-h3-ref'), [[0, 2], [2, 5]]), LIB);
  // 5s at 24fps wants 120 frames, but the grid only offers 5 + 17n. 124 is the
  // nearest, which is 4.96s — the grid cannot express exactly five seconds.
  assert.equal(frames(out), 124);
  assert.equal((124 - 5) % 17, 0, 'lands on the grid');
  assert.ok(Math.abs((124 - 5) / 24 - 5) < 0.05, 'and is within a frame or two of five seconds');
});

test('a longer shot list makes a longer clip', () => {
  const five = syncClipLength(withShots(load('video-h3-ref'), [[0, 5]]), LIB);
  const twelve = syncClipLength(withShots(load('video-h3-ref'), [[0, 12]]), LIB);
  assert.ok(frames(twelve) > frames(five), `${frames(twelve)} should exceed ${frames(five)}`);
});

test('the clip lands within half a grid step of the shot list', () => {
  // The grid is 17 frames at 24fps, so the worst case is ~0.35s either way.
  const tolerance = 17 / 24 / 2 + 0.001;
  for (const secs of [1, 3, 5, 7, 9, 11, 15]) {
    const out = syncClipLength(withShots(load('video-h3-ref'), [[0, secs]]), LIB);
    const actual = (frames(out) - 5) / 24;
    assert.ok(
      Math.abs(actual - secs) <= tolerance,
      `${secs}s of shots gave a ${actual.toFixed(2)}s clip`,
    );
  }
});

test('an empty shot list leaves the length alone', () => {
  const base = load('video-h3-ref');
  assert.equal(frames(syncClipLength(withShots(base, []), LIB)), frames(base));
});

test('a stack with no script is untouched', () => {
  const base = load('video-ltx');
  assert.deepEqual(syncClipLength(base, LIB), base);
});

test('running it twice changes nothing the second time', () => {
  const once = syncClipLength(withShots(load('video-h3-ref'), [[0, 2], [2, 7]]), LIB);
  assert.deepEqual(syncClipLength(once, LIB), once);
});

test('the script that caused the trouble now sets a five second clip', () => {
  // 0-2, 2-2, 4-5 — the shots ran to 5s while the clip was set to 10s.
  const out = syncClipLength(withShots(load('video-h3-ref'), [[0, 2], [2, 2], [4, 5]]), LIB);
  assert.equal(frames(out), 124);
});
