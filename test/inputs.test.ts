/**
 * Repeatable input slots.
 *
 * Each slot loads through its own module because each publishes a
 * differently-named output — H3 addresses its nine reference images
 * individually as ref_image_0 … _8. Handing two slots the same loader means two
 * carry entries with the same name, the later overwriting the earlier, and an
 * image that silently never reaches the model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addInput, removeInput, inputList } from '../web/src/lib/stackOps.ts';
import { migrate } from '../shared/migrate.ts';
import type { Module, ModuleLibrary, Stack } from '../shared/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function library(dir = join(ROOT, 'modules'), lib: ModuleLibrary = {}): ModuleLibrary {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) library(full, lib);
    else if (e.name.endsWith('.json')) {
      const m = JSON.parse(readFileSync(full, 'utf8')) as Module;
      lib[m.id] = m;
    }
  }
  return lib;
}

const LIB = library();
const load = (id: string): Stack =>
  migrate(JSON.parse(readFileSync(join(ROOT, 'stacks', `${id}.json`), 'utf8')));

/** The loader module of every slot of this kind, in stack order. */
const loadersOf = (stack: Stack, kind: string) =>
  stack.lines
    .flatMap((l) => l.tiles)
    .filter((t) => t.id.startsWith(`in.${kind}.`) && t.id.endsWith('.0'))
    .map((t) => t.moduleId);

test('every slot gets a loader of its own', () => {
  const stack = load('video-h3-ref');
  const kind = stack.inputs!.kinds.find((k) => k.id === 'ref')!;
  const loaders = loadersOf(stack, 'ref');
  assert.equal(new Set(loaders).size, loaders.length, `duplicates: ${loaders.join(', ')}`);
});

test('removing a slot then adding one does not reuse a loader', () => {
  // Three slots, delete the first, add one. Counting slots would hand out the
  // third loader a second time.
  const stack = load('video-h3-ref');
  const kind = stack.inputs!.kinds.find((k) => k.id === 'ref')!;

  const first = inputList(stack).find((r) => r.kind === 'ref')!;
  const after = addInput(removeInput(stack, first.group), kind);

  const loaders = loadersOf(after, 'ref');
  assert.equal(new Set(loaders).size, loaders.length, `duplicates: ${loaders.join(', ')}`);
  assert.ok(loaders.includes(kind.loaderByIndex![0]!), 'the freed slot is the one reused');
});

test('adding and removing repeatedly never duplicates', () => {
  const stack = load('video-h3-ref');
  const kind = stack.inputs!.kinds.find((k) => k.id === 'ref')!;

  let s = stack;
  for (let i = 0; i < 6; i++) {
    const refs = inputList(s).filter((r) => r.kind === 'ref');
    if (refs.length > 1 && i % 2 === 0) s = removeInput(s, refs[i % refs.length]!.group);
    else s = addInput(s, kind);

    const loaders = loadersOf(s, 'ref');
    assert.equal(new Set(loaders).size, loaders.length, `round ${i}: ${loaders.join(', ')}`);
  }
});

test('the modules the slots use all exist', () => {
  const stack = load('video-h3-ref');
  for (const id of loadersOf(stack, 'ref')) {
    assert.ok(LIB[id], `no module "${id}" in the library`);
  }
});
