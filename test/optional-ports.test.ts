/**
 * An optional port is wired by name, or not at all.
 *
 * The compiler falls back to matching on type when a port name is not in the
 * carry: one LATENT in scope and a module wanting a LATENT is unambiguous. On
 * an *optional* port that rule does damage. MiniMaxH3ReferenceToVideo declares
 * nine reference image ports and three reference video ports, all typed IMAGE,
 * so a single reference image was wired into all twelve — and the run failed
 * with "reference videos need at least 5 frames" for videos that were never
 * loaded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../shared/compile.ts';
import { migrate } from '../shared/migrate.ts';
import type { Module, ModuleLibrary } from '../shared/types.ts';

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
const load = (id: string) => migrate(JSON.parse(readFileSync(join(ROOT, 'stacks', `${id}.json`), 'utf8')));

/** One reference image loaded, nothing else. */
function withOneImage() {
  const stack = load('video-h3-ref');
  let first = true;
  return {
    ...stack,
    lines: stack.lines.map((l) => ({
      ...l,
      tiles: l.tiles.map((t) => {
        if (!t.id.startsWith('in.')) return t;
        const params = { ...t.params, image: first ? 'Mountains.jpg' : '' };
        first = false;
        return { ...t, params };
      }),
    })),
  };
}

test('a lone reference image does not fill the video slots', () => {
  const { prompt } = compile(withOneImage(), LIB);
  const ref = Object.values(prompt).find((n) => n.class_type === 'MiniMaxH3ReferenceToVideo');
  assert.ok(ref, 'the reference node is in the graph');

  const videoPorts = Object.keys(ref.inputs).filter((k) => k.startsWith('ref_videos.'));
  const wired = videoPorts.filter((k) => Array.isArray(ref.inputs[k]));
  assert.deepEqual(wired, [], `no video reference should be wired, got ${wired.join(', ')}`);
});

test('no single loader is wired into more than one reference slot', () => {
  // The stack ships with three image slots, each with its own loader, so three
  // wired image ports is right. What must never happen is one loader feeding
  // several ports — that is the duplication the type fallback caused, and it is
  // what put a still into the video slots.
  const { prompt } = compile(withOneImage(), LIB);
  const ref = Object.values(prompt).find((n) => n.class_type === 'MiniMaxH3ReferenceToVideo')!;

  const sources = new Map<string, string[]>();
  for (const [port, value] of Object.entries(ref.inputs)) {
    if (!port.startsWith('ref_')) continue;
    if (!Array.isArray(value)) continue;
    const node = String(value[0]);
    sources.set(node, [...(sources.get(node) ?? []), port]);
  }

  for (const [node, ports] of sources) {
    assert.equal(ports.length, 1, `node ${node} feeds ${ports.length} ports: ${ports.join(', ')}`);
  }
});

test('required ports still resolve by type', () => {
  // The fallback is what lets a module skip stating the obvious, and it has to
  // keep working: every shipped pipeline depends on it.
  for (const id of ['video-ltx', 'video-h3', 'example-z-image', 'example-txt2img']) {
    const { issues } = compile(load(id), LIB);
    const unresolved = issues.filter((i) => i.code === 'unresolved-port');
    assert.deepEqual(unresolved, [], `${id}: ${unresolved.map((i) => i.message).join('; ')}`);
  }
});
