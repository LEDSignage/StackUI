/**
 * Clearing the page empties what you filled in and nothing else.
 *
 * The failure to guard against is a Clear that also resets size, seed, steps or
 * frame rate — you would then have to re-dial the whole page after every run,
 * which is worse than clearing by hand.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearJobFields, findTile } from '../web/src/lib/stackOps.ts';
import { migrate } from '../shared/migrate.ts';
import type { Module, ModuleLibrary, Stack } from '../shared/types.ts';

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
const load = (id: string) => migrate(JSON.parse(readFileSync(join(ROOT, 'stacks', `${id}.json`), 'utf8')));

const value = (s: Stack, tileId: string, param: string) => findTile(s, tileId)?.params[param];

test('the prompt and the files go', () => {
  let s = load('video-ltx');
  s = set(s, 't-prompt', 'positive', 'a cat on a roof');
  s = set(s, 'in.frame.k1.0', 'image', 'start.png');
  s = set(s, 'in.frame.k2.0', 'image', 'end.png');

  const cleared = clearJobFields(s, LIB);

  assert.equal(cleared.controls?.length, s.controls?.length, 'controls are untouched');
  assert.equal(value(cleared, 't-prompt', 'positive'), '');
  assert.equal(value(cleared, 'in.frame.k1.0', 'image'), '');
  assert.equal(value(cleared, 'in.frame.k2.0', 'image'), '');
});

test('the settings stay', () => {
  let s = load('video-ltx');
  s = set(s, 't-latent', 'width', 1920);
  s = set(s, 't-sample', 'seed', 4242);
  s = set(s, 't-sample', 'steps', 12);
  s = set(s, 't-ltxcond', 'frame_rate', 30);

  const cleared = clearJobFields(s, LIB);

  assert.equal(value(cleared, 't-latent', 'width'), 1920);
  assert.equal(value(cleared, 't-sample', 'seed'), 4242);
  assert.equal(value(cleared, 't-sample', 'steps'), 12);
  assert.equal(value(cleared, 't-ltxcond', 'frame_rate'), 30);
});

test('the input slots survive, empty', () => {
  const s = load('video-ltx');
  const before = s.lines.flatMap((l) => l.tiles).filter((t) => t.id.startsWith('in.')).length;
  const after = clearJobFields(s, LIB)
    .lines.flatMap((l) => l.tiles)
    .filter((t) => t.id.startsWith('in.')).length;

  assert.ok(before > 0, 'this pipeline ships with input slots');
  assert.equal(after, before, 'a start and end frame slot are part of the pipeline, not your input');
});

test('the shot list empties, and so does the prompt it writes', () => {
  const base = load('video-h3');
  assert.ok(base.script, 'this pipeline has a script');

  const s: Stack = {
    ...base,
    script: {
      ...base.script!,
      vision: 'noir, rain',
      shots: [{ from: 0, to: 2, text: 'a door opens' }],
      audio: 'low strings',
    },
  };

  const cleared = clearJobFields(s, LIB);

  assert.equal(cleared.script?.vision, '');
  assert.deepEqual(cleared.script?.shots, []);
  assert.equal(cleared.script?.audio, '');
  assert.deepEqual(cleared.script?.target, base.script!.target, 'still points at the same param');
  assert.equal(value(cleared, base.script!.target.tileId, base.script!.target.param), '');
});

test('clearing twice is the same as clearing once', () => {
  const once = clearJobFields(load('video-h3-ref'), LIB);
  assert.deepEqual(clearJobFields(once, LIB), once);
});

function set(stack: Stack, tileId: string, param: string, v: unknown): Stack {
  return {
    ...stack,
    lines: stack.lines.map((l) => ({
      ...l,
      tiles: l.tiles.map((t) => (t.id === tileId ? { ...t, params: { ...t.params, [param]: v } } : t)),
    })),
  };
}
