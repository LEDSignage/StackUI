/**
 * Build-order step 2: the diff that actually proves the compiler.
 *
 * `fixtures/zimage_t2i.api.json` is a known-good API-format graph — it has been
 * driving real Z-Image generation in the LTX Automation pipeline. We build the
 * equivalent stack out of real module files from `modules/`, compile it, and
 * assert the two graphs are structurally identical.
 *
 * Node ids will differ. Nothing else may.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../shared/compile.ts';
import { graphDiff, signatures } from './graphEqual.ts';
import {
  SCHEMA_VERSION,
  type ApiPrompt,
  type Module,
  type ModuleLibrary,
  type Stack,
  type Tile,
} from '../shared/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = join(HERE, '..', 'modules');

/**
 * The real library off disk — so a broken module file fails a test, not a run.
 * Recurses, so the generated module per installed node class is covered too.
 */
function loadLibrary(dir = MODULES, lib: ModuleLibrary = {}): ModuleLibrary {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      loadLibrary(full, lib);
      continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    const m = JSON.parse(readFileSync(full, 'utf8')) as Module;
    lib[m.id] = m;
  }
  return lib;
}

const library = loadLibrary();

const reference = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'zimage_t2i.api.json'), 'utf8'),
) as ApiPrompt;

function tile(id: string, moduleId: string, params: Record<string, unknown> = {}): Tile {
  return { id, moduleId, params, collapsed: true };
}

function line(id: string, tiles: Tile[]) {
  return { id, mode: 'parallel' as const, bypassed: false, tiles };
}

/**
 * The same pipeline as the reference graph, expressed as a stack.
 *
 * Line 1 is the three loaders — nothing depends on anything, so they are
 * genuinely concurrent and belong side by side (spec §10).
 */
const zImageStack: Stack = {
  schemaVersion: SCHEMA_VERSION,
  id: 'z-image-turbo',
  name: 'Z-Image Turbo',
  lines: [
    line('l1', [
      tile('t-model', 'z-image-model', { unet_name: 'z_image_turbo_bf16.safetensors', shift: 3 }),
      tile('t-clip', 'clip-loader', { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2' }),
      tile('t-vae', 'vae-loader', { vae_name: 'ae.safetensors' }),
    ]),
    line('l2', [tile('t-prompt', 'prompt-zeroed', { prompt: '' })]),
    line('l3', [tile('t-canvas', 'canvas-sd3', { width: 1360, height: 768 })]),
    line('l4', [
      tile('t-sample', 'sample', {
        seed: 0,
        steps: 8,
        cfg: 1,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        denoise: 1,
      }),
    ]),
    line('l5', [tile('t-decode', 'decode')]),
    line('l6', [tile('t-save', 'save-image', { filename_prefix: 'z-image-turbo' })]),
  ],
};

test('every module file on disk parses and declares its outputs', () => {
  for (const [id, m] of Object.entries(library)) {
    assert.equal(m.id, id, 'module id matches its key');
    assert.ok(m.name && m.category, `${id} has a name and category`);
    for (const port of m.outPorts) {
      const backed = m.outputs?.[port.name] ?? (Object.keys(m.nodes).length === 1 ? true : undefined);
      assert.ok(backed, `${id} says which node backs out-port "${port.name}"`);
    }
    for (const p of m.params) {
      assert.ok(m.nodes[p.target.node], `${id} param "${p.name}" targets a node it defines`);
    }
  }
});

test('the Z-Image stack compiles cleanly', () => {
  const r = compile(zImageStack, library);
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
});

test('STEP 2 — compiled output is structurally identical to the known-good graph', () => {
  const r = compile(zImageStack, library);
  const diff = graphDiff(r.prompt, reference);

  assert.deepEqual(
    diff,
    { onlyInA: [], onlyInB: [] },
    `\nOurs only:\n  ${diff.onlyInA.join('\n  ')}\nReference only:\n  ${diff.onlyInB.join('\n  ')}\n`,
  );
});

test('node counts match', () => {
  const r = compile(zImageStack, library);
  assert.equal(Object.keys(r.prompt).length, Object.keys(reference).length);
});

test('the signature function actually discriminates', () => {
  // Guard against a comparison that passes because it compares nothing.
  const tweaked: ApiPrompt = JSON.parse(JSON.stringify(reference));
  tweaked['3']!.inputs.steps = 9;
  assert.notDeepEqual(signatures(tweaked), signatures(reference));
});
