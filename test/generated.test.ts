/**
 * The generated library must actually be usable, not merely present.
 *
 * `scripts/generate-modules.mjs` turns every installed ComfyUI node class into a
 * module. These tests build real stacks out of those generated modules and check
 * the compiler produces a sane graph — in particular that a sampler's positive
 * and negative conditioning end up on the right inputs, which is the thing
 * type-based port naming used to destroy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../shared/compile.ts';
import { SCHEMA_VERSION, type Module, type ModuleLibrary, type Stack, type Tile } from '../shared/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = join(HERE, '..', 'modules');
const GENERATED = join(MODULES, 'generated');

function loadLibrary(dir = MODULES, lib: ModuleLibrary = {}): ModuleLibrary {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) loadLibrary(full, lib);
    else if (entry.name.endsWith('.json')) {
      const m = JSON.parse(readFileSync(full, 'utf8')) as Module;
      lib[m.id] = m;
    }
  }
  return lib;
}

const hasGenerated = existsSync(GENERATED);
const library = loadLibrary();

const tile = (id: string, moduleId: string, params: Record<string, unknown> = {}): Tile => ({
  id,
  moduleId,
  params,
  collapsed: true,
});
const line = (id: string, tiles: Tile[]) => ({ id, mode: 'parallel' as const, bypassed: false, tiles });
const stackOf = (...lines: ReturnType<typeof line>[]): Stack => ({
  schemaVersion: SCHEMA_VERSION,
  id: 'gen-test',
  name: 'generated',
  lines,
});

test('generated modules exist and cover the whole install', { skip: !hasGenerated }, () => {
  const gen = Object.values(library).filter((m) => m.id.startsWith('gen.'));
  assert.ok(gen.length > 100, `expected the full node set, got ${gen.length}`);
});

test('a sampler names its conditioning inputs positive and negative', { skip: !hasGenerated }, () => {
  const ks = library['gen.KSampler'];
  assert.ok(ks, 'KSampler was generated');
  assert.deepEqual(
    ks!.inPorts.map((p) => p.name),
    ['model', 'positive', 'negative', 'latent_image'],
    'ports carry ComfyUI’s own input names, not their types',
  );
});

test('generated modules interoperate with the curated ones', { skip: !hasGenerated }, () => {
  // The curated Prompts module publishes `positive` and `negative`; the
  // generated KSampler asks for exactly those names. They should meet.
  const s = stackOf(
    line('l1', [tile('t1', 'gen.CheckpointLoaderSimple'), tile('t2', 'gen.EmptyLatentImage')]),
    line('l2', [tile('t3', 'prompts', { positive: 'a lighthouse', negative: 'blurry' })]),
    line('l3', [tile('t4', 'gen.KSampler', { steps: 12 })]),
    line('l4', [tile('t5', 'gen.VAEDecode')]),
    line('l5', [tile('t6', 'gen.SaveImage')]),
  );

  const r = compile(s, library);
  assert.deepEqual(r.issues, [], 'compiles with no issues');

  const ks = Object.values(r.prompt).find((n) => n.class_type === 'KSampler');
  assert.ok(ks, 'a KSampler was emitted');

  const posId = (ks!.inputs.positive as [string, number])[0];
  const negId = (ks!.inputs.negative as [string, number])[0];
  assert.notEqual(posId, negId, 'positive and negative come from different nodes');
  assert.equal(r.prompt[posId]!.inputs.text, 'a lighthouse', 'positive carries the positive prompt');
  assert.equal(r.prompt[negId]!.inputs.text, 'blurry', 'negative carries the negative prompt');
});

test('a stack built only from generated modules compiles', { skip: !hasGenerated }, () => {
  const s = stackOf(
    line('l1', [tile('t1', 'gen.CheckpointLoaderSimple'), tile('t2', 'gen.EmptyLatentImage')]),
    line('l2', [tile('t3', 'gen.CLIPTextEncode', { text: 'a lighthouse' })]),
    line('l3', [tile('t4', 'gen.KSampler')]),
    line('l4', [tile('t5', 'gen.VAEDecode')]),
    line('l5', [tile('t6', 'gen.SaveImage')]),
  );
  const r = compile(s, library);

  // One CLIPTextEncode publishes a single `conditioning`, so both of the
  // sampler's inputs fall back to it by type. That is a real limitation, and
  // the compiler must resolve it rather than silently dropping an input.
  const ks = Object.values(r.prompt).find((n) => n.class_type === 'KSampler');
  assert.ok(ks, 'a KSampler was emitted');
  assert.ok(Array.isArray(ks!.inputs.positive), 'positive is wired');
  assert.ok(Array.isArray(ks!.inputs.negative), 'negative is wired');
  assert.equal(r.issues.filter((i) => i.severity === 'error').length, 0);
});

test('every generated module is internally consistent', { skip: !hasGenerated }, () => {
  for (const m of Object.values(library)) {
    if (!m.id.startsWith('gen.')) continue;
    for (const p of m.params) {
      assert.ok(m.nodes[p.target.node], `${m.id}: param ${p.name} targets a missing node`);
    }
    for (const port of m.outPorts) {
      const backed = m.outputs?.[port.name] ?? (Object.keys(m.nodes).length === 1);
      assert.ok(backed, `${m.id}: out-port ${port.name} has no backing node`);
    }
    const names = m.inPorts.map((p) => p.name);
    assert.equal(new Set(names).size, names.length, `${m.id}: duplicate in-port names`);
  }
});
