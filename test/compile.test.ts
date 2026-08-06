/**
 * Compiler tests. Spec §5 is the whole project, so this is where the effort goes.
 *
 * These check structure, not ComfyUI acceptance. The acceptance check is
 * build-order step 2: diff a compiled prompt against ComfyUI's own
 * "Save (API Format)" export of the equivalent graph. See test/fixtures/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../shared/compile.ts';
import { SCHEMA_VERSION, type Module, type ModuleLibrary, type Stack, type Tile } from '../shared/types.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

const loader: Module = {
  id: 'loader',
  name: 'Checkpoint',
  category: 'load',
  inPorts: [],
  outPorts: [
    { name: 'model', type: 'MODEL' },
    { name: 'clip', type: 'CLIP' },
    { name: 'vae', type: 'VAE' },
  ],
  outputs: { model: { node: 'ckpt', out: 0 }, clip: { node: 'ckpt', out: 1 }, vae: { node: 'ckpt', out: 2 } },
  params: [
    {
      name: 'ckpt_name',
      label: 'Checkpoint',
      type: 'ENUM',
      default: 'sd_xl_base_1.0.safetensors',
      target: { node: 'ckpt', input: 'ckpt_name' },
    },
  ],
  nodes: {
    ckpt: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'placeholder' } },
  },
};

/** Two nodes, one param each, forward intra-module ref. */
const prompts: Module = {
  id: 'prompts',
  name: 'Prompts',
  category: 'conditioning',
  inPorts: [{ name: 'clip', type: 'CLIP' }],
  outPorts: [
    { name: 'positive', type: 'CONDITIONING' },
    { name: 'negative', type: 'CONDITIONING' },
  ],
  outputs: { positive: { node: 'pos' }, negative: { node: 'neg' } },
  params: [
    { name: 'positive', label: 'Positive', type: 'STRING', default: '', target: { node: 'pos', input: 'text' } },
    { name: 'negative', label: 'Negative', type: 'STRING', default: '', target: { node: 'neg', input: 'text' } },
  ],
  nodes: {
    pos: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: { $port: 'clip' } } },
    neg: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: { $port: 'clip' } } },
  },
};

const sampler: Module = {
  id: 'sampler',
  name: 'Sample',
  category: 'sampling',
  inPorts: [
    { name: 'model', type: 'MODEL' },
    { name: 'positive', type: 'CONDITIONING' },
    { name: 'negative', type: 'CONDITIONING' },
  ],
  outPorts: [{ name: 'latent', type: 'LATENT' }],
  outputs: { latent: { node: 'ks' } },
  passThrough: {},
  params: [
    { name: 'steps', label: 'Steps', type: 'INT', default: 20, target: { node: 'ks', input: 'steps' } },
    { name: 'width', label: 'Width', type: 'INT', default: 1024, target: { node: 'empty', input: 'width' } },
  ],
  nodes: {
    empty: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    ks: {
      class_type: 'KSampler',
      inputs: {
        model: { $port: 'model' },
        positive: { $port: 'positive' },
        negative: { $port: 'negative' },
        latent_image: { $node: 'empty', out: 0 },
        seed: 0,
        steps: 20,
        cfg: 8,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
      },
    },
  },
};

const decode: Module = {
  id: 'decode',
  name: 'Decode',
  category: 'latent',
  inPorts: [
    { name: 'latent', type: 'LATENT' },
    { name: 'vae', type: 'VAE' },
  ],
  outPorts: [{ name: 'image', type: 'IMAGE' }],
  passThrough: {},
  params: [],
  nodes: { vd: { class_type: 'VAEDecode', inputs: { samples: { $port: 'latent' }, vae: { $port: 'vae' } } } },
};

/** An optional post step, so bypass has something real to skip. */
const upscale: Module = {
  id: 'upscale',
  name: 'Upscale',
  category: 'image',
  inPorts: [{ name: 'image', type: 'IMAGE' }],
  outPorts: [{ name: 'image', type: 'IMAGE' }],
  passThrough: { image: 'image' },
  params: [],
  nodes: {
    up: {
      class_type: 'ImageScaleBy',
      inputs: { image: { $port: 'image' }, upscale_method: 'lanczos', scale_by: 2 },
    },
  },
};

const save: Module = {
  id: 'save',
  name: 'Save',
  category: 'output',
  terminal: true,
  inPorts: [{ name: 'image', type: 'IMAGE' }],
  outPorts: [],
  params: [],
  nodes: {
    s: { class_type: 'SaveImage', inputs: { images: { $port: 'image' }, filename_prefix: 'StackUI' } },
  },
};

const library: ModuleLibrary = Object.fromEntries(
  [loader, prompts, sampler, decode, upscale, save].map((m) => [m.id, m]),
);

// ── Builders ────────────────────────────────────────────────────────────────

function tile(moduleId: string, params: Record<string, unknown> = {}, over: Partial<Tile> = {}): Tile {
  return { id: `t-${moduleId}`, moduleId, params, collapsed: true, ...over };
}

function stackOf(...lines: Tile[][]): Stack {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 's1',
    name: 'test',
    lines: lines.map((tiles, i) => ({ id: `l${i}`, mode: 'parallel', bypassed: false, tiles })),
  };
}

/** Bypass is a line-level switch, so tests set it on the line. */
function bypassLine(stack: Stack, index: number): Stack {
  stack.lines[index]!.bypassed = true;
  return stack;
}

const basic = () =>
  stackOf(
    [tile('loader')],
    [tile('prompts', { positive: 'a cat' })],
    [tile('sampler', { steps: 12 })],
    [tile('decode')],
    [tile('save')],
  );

// ── Tests ───────────────────────────────────────────────────────────────────

test('a linear stack compiles with no issues', () => {
  const r = compile(basic(), library);
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('every node in the prompt is API-shaped', () => {
  const { prompt } = compile(basic(), library);
  for (const [id, node] of Object.entries(prompt)) {
    assert.match(id, /^\d+$/, 'node ids are numeric strings');
    assert.equal(typeof node.class_type, 'string');
    assert.equal(typeof node.inputs, 'object');
  }
});

test('connections are [node_id, output_index] with string ids', () => {
  const { prompt } = compile(basic(), library);
  const ks = Object.values(prompt).find((n) => n.class_type === 'KSampler')!;
  const model = ks.inputs.model as [string, number];
  assert.ok(Array.isArray(model));
  assert.equal(model.length, 2);
  assert.equal(typeof model[0], 'string');
  assert.equal(typeof model[1], 'number');
  assert.ok(prompt[model[0]], 'the link points at a node that exists');
});

test('output index is carried through, not assumed zero', () => {
  const { prompt } = compile(basic(), library);
  const decodeNode = Object.values(prompt).find((n) => n.class_type === 'VAEDecode')!;
  // vae is out-port 2 of CheckpointLoaderSimple
  assert.equal((decodeNode.inputs.vae as [string, number])[1], 2);
});

test('params override the module graph; defaults fill the rest', () => {
  const { prompt } = compile(basic(), library);
  const ks = Object.values(prompt).find((n) => n.class_type === 'KSampler')!;
  assert.equal(ks.inputs.steps, 12, 'tile param wins');
  assert.equal(ks.inputs.cfg, 8, 'untouched graph literal survives');
  const empty = Object.values(prompt).find((n) => n.class_type === 'EmptyLatentImage')!;
  assert.equal(empty.inputs.width, 1024, 'param default applies when the tile omits it');
});

test('a param can target a different node than the one holding the port', () => {
  const s = basic();
  s.lines[2]!.tiles[0]!.params = { width: 512 };
  const { prompt } = compile(s, library);
  const empty = Object.values(prompt).find((n) => n.class_type === 'EmptyLatentImage')!;
  assert.equal(empty.inputs.width, 512);
});

test('intra-module refs resolve to the same tile', () => {
  const { prompt, tileMap } = compile(basic(), library);
  const ks = Object.entries(prompt).find(([, n]) => n.class_type === 'KSampler')!;
  const latentSrc = (ks[1].inputs.latent_image as [string, number])[0];
  assert.equal(tileMap[latentSrc], tileMap[ks[0]], 'EmptyLatentImage belongs to the sampler tile');
});

test('tileMap covers every node', () => {
  const { prompt, tileMap } = compile(basic(), library);
  for (const id of Object.keys(prompt)) assert.ok(tileMap[id], `node ${id} has an owning tile`);
});

test('two prompt tiles on one parallel line both see the same carry', () => {
  const s = stackOf(
    [tile('loader')],
    [tile('prompts', {}, { id: 'a' }), tile('prompts', {}, { id: 'b' })],
  );
  const r = compile(s, library);
  assert.equal(r.issues.filter((i) => i.severity === 'error').length, 0);
  const encodes = Object.values(r.prompt).filter((n) => n.class_type === 'CLIPTextEncode');
  assert.equal(encodes.length, 4, 'both tiles emitted');
});

test('parallel: the later tile on a line wins the carry name', () => {
  const s = stackOf(
    [tile('loader')],
    [tile('prompts', { positive: 'first' }, { id: 'a' }), tile('prompts', { positive: 'second' }, { id: 'b' })],
    [tile('sampler')],
  );
  const r = compile(s, library);
  const ks = Object.values(r.prompt).find((n) => n.class_type === 'KSampler')!;
  const posId = (ks.inputs.positive as [string, number])[0];
  assert.equal(r.prompt[posId]!.inputs.text, 'second');
});

test('parallel: a tile does not see its line-mate output', () => {
  // decode needs `latent`; sampler is on the same line, so decode cannot see it.
  const s = stackOf([tile('loader')], [tile('prompts')], [tile('sampler'), tile('decode')]);
  const r = compile(s, library);
  assert.ok(r.issues.some((i) => i.code === 'unresolved-port' && i.tileId === 't-decode'));
  assert.equal(r.ok, false);
});

test('wired: a tile does see its line-mate output', () => {
  const s = stackOf([tile('loader')], [tile('prompts')], [tile('sampler'), tile('decode')]);
  s.lines[2]!.mode = 'wired';
  const r = compile(s, library);
  assert.equal(r.ok, true);
  const vd = Object.values(r.prompt).find((n) => n.class_type === 'VAEDecode')!;
  const src = (vd.inputs.samples as [string, number])[0];
  assert.equal(r.prompt[src]!.class_type, 'KSampler');
});

test('names accumulate across lines — a value stays in the carry indefinitely', () => {
  // vae comes from line 0; decode on line 4 still resolves it.
  const r = compile(basic(), library);
  assert.equal(r.ok, true);
  assert.ok(r.finalCarry.some((e) => e.name === 'vae'));
});

test('unresolved port names the tile, not the node', () => {
  const s = stackOf([tile('sampler')]); // nothing upstream
  const r = compile(s, library);
  const issue = r.issues.find((i) => i.code === 'unresolved-port')!;
  assert.equal(issue.tileId, 't-sampler');
  assert.equal(issue.severity, 'error');
});

test('unknown module is an error against the tile, not a crash', () => {
  const s = stackOf([tile('nope')]);
  const r = compile(s, library);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0]!.code, 'unknown-module');
});

test('a bypassed line emits no nodes and aliases the carry through', () => {
  const s = bypassLine(
    stackOf(
      [tile('loader')],
      [tile('prompts')],
      [tile('sampler')],
      [tile('decode')],
      [tile('upscale')],
      [tile('save')],
    ),
    4,
  );
  const r = compile(s, library);
  assert.equal(r.ok, true);
  assert.equal(
    Object.values(r.prompt).some((n) => n.class_type === 'ImageScaleBy'),
    false,
    'bypassed tile emitted nothing',
  );
  const saveNode = Object.values(r.prompt).find((n) => n.class_type === 'SaveImage')!;
  const src = (saveNode.inputs.images as [string, number])[0];
  assert.equal(r.prompt[src]!.class_type, 'VAEDecode', 'save reads straight through the bypass');
});

test('bypassing a line with no passThrough warns and breaks downstream', () => {
  const s = bypassLine(
    stackOf([tile('loader')], [tile('prompts')], [tile('sampler')], [tile('decode')]),
    2,
  );
  const r = compile(s, library);
  assert.ok(r.issues.some((i) => i.code === 'bypass-unsafe' && i.tileId === 't-sampler'));
  assert.ok(r.issues.some((i) => i.code === 'unresolved-port' && i.tileId === 't-decode'));
});

test('no terminal node is a warning, not an error', () => {
  const s = stackOf([tile('loader')], [tile('prompts')], [tile('sampler')], [tile('decode')]);
  const r = compile(s, library);
  assert.ok(r.issues.some((i) => i.code === 'no-terminal' && i.severity === 'warning'));
  assert.equal(r.ok, true, 'a warning does not block');
});

test('autoSave appends a save node bound to the last IMAGE in the carry', () => {
  const s = stackOf([tile('loader')], [tile('prompts')], [tile('sampler')], [tile('decode')]);
  const r = compile(s, library, { autoSave: true });
  const saveNode = Object.values(r.prompt).find((n) => n.class_type === 'SaveImage');
  assert.ok(saveNode, 'a save node was appended');
  const src = (saveNode!.inputs.images as [string, number])[0];
  assert.equal(r.prompt[src]!.class_type, 'VAEDecode');
  assert.equal(r.issues.length, 0);
});

test('a terminal module suppresses the no-terminal warning', () => {
  const r = compile(basic(), library);
  assert.equal(r.issues.some((i) => i.code === 'no-terminal'), false);
});

test('carryAtLine records what each line could see', () => {
  const r = compile(basic(), library);
  assert.deepEqual(r.carryAtLine.l0, [], 'the first line starts empty');
  assert.deepEqual(
    r.carryAtLine.l1!.map((e) => e.name).sort(),
    ['clip', 'model', 'vae'],
  );
  assert.ok(r.carryAtLine.l4!.some((e) => e.name === 'image'));
});

test('port names fall back to a unique type match', () => {
  // `renamed` publishes IMAGE under a different name; save wants `image`.
  const renamed: Module = { ...decode, id: 'renamed', outPorts: [{ name: 'picture', type: 'IMAGE' }] };
  const lib = { ...library, renamed };
  const s = stackOf([tile('loader')], [tile('prompts')], [tile('sampler')], [tile('renamed')], [tile('save')]);
  const r = compile(s, lib);
  assert.equal(r.ok, true, 'one IMAGE in scope is unambiguous');
});

test('an ambiguous type match is unresolved rather than guessed', () => {
  const renamed: Module = { ...decode, id: 'renamed', outPorts: [{ name: 'picture', type: 'IMAGE' }] };
  const renamed2: Module = { ...decode, id: 'renamed2', outPorts: [{ name: 'other', type: 'IMAGE' }] };
  const lib = { ...library, renamed, renamed2 };
  const s = stackOf(
    [tile('loader')],
    [tile('prompts')],
    [tile('sampler')],
    [tile('renamed'), tile('renamed2')],
    [tile('save')],
  );
  const r = compile(s, lib);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'unresolved-port' && i.tileId === 't-save'));
});

test('node ids are unique across repeated instances of the same module', () => {
  const s = stackOf(
    [tile('loader')],
    [tile('prompts', {}, { id: 'a' })],
    [tile('prompts', {}, { id: 'b' })],
  );
  const r = compile(s, library);
  assert.equal(Object.keys(r.prompt).length, 5, 'loader (1) + two prompt tiles (2 each)');
  assert.equal(new Set(Object.keys(r.prompt)).size, 5);
});

test('compiling twice gives identical output', () => {
  const a = compile(basic(), library);
  const b = compile(basic(), library);
  assert.deepEqual(a.prompt, b.prompt);
  assert.deepEqual(a.tileMap, b.tileMap);
});

test('an empty stack compiles to nothing, with a warning', () => {
  const r = compile(stackOf(), library);
  assert.deepEqual(r.prompt, {});
  assert.ok(r.issues.some((i) => i.code === 'no-terminal'));
});
