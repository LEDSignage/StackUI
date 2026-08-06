/**
 * Migration tests. A stack is a file on disk that outlives the code that wrote
 * it, so every schema bump needs one of these.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../shared/migrate.ts';
import { compile } from '../shared/compile.ts';
import { SCHEMA_VERSION } from '../shared/types.ts';

const v1 = {
  schemaVersion: 1,
  id: 'old',
  name: 'Old stack',
  lines: [
    {
      id: 'l1',
      mode: 'parallel',
      tiles: [
        { id: 't1', moduleId: 'checkpoint', params: {}, bypassed: false, collapsed: true },
        { id: 't2', moduleId: 'canvas', params: {}, bypassed: false, collapsed: true },
      ],
    },
    {
      id: 'l2',
      mode: 'parallel',
      tiles: [{ id: 't3', moduleId: 'upscale-image', params: {}, bypassed: true, collapsed: false }],
    },
  ],
};

test('v1 → v2 moves bypass from the tile to the line', () => {
  const s = migrate(structuredClone(v1));
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.equal(s.lines[0]!.bypassed, false);
  assert.equal(s.lines[1]!.bypassed, true, 'the line inherits its bypassed tile');
});

test('v1 → v2 strips the old per-tile flag', () => {
  const s = migrate(structuredClone(v1));
  for (const line of s.lines) {
    for (const tile of line.tiles) {
      assert.equal('bypassed' in tile, false, 'no stale bypassed key survives on a tile');
    }
  }
});

test('migration preserves everything else', () => {
  const s = migrate(structuredClone(v1));
  assert.equal(s.id, 'old');
  assert.equal(s.name, 'Old stack');
  assert.deepEqual(
    s.lines.map((l) => l.tiles.map((t) => t.moduleId)),
    [['checkpoint', 'canvas'], ['upscale-image']],
  );
  assert.equal(s.lines[1]!.tiles[0]!.collapsed, false, 'collapse state survives');
});

test('migrating an already-current stack is a no-op', () => {
  const current = migrate(structuredClone(v1));
  assert.deepEqual(migrate(structuredClone(current)), current);
});

test('a migrated stack compiles', () => {
  // The compiler reads line.bypassed now; a half-migrated stack would throw or
  // silently emit the wrong graph.
  const s = migrate(structuredClone(v1));
  const r = compile(s, {});
  assert.ok(Array.isArray(r.issues));
});

test('missing optional fields get defaults', () => {
  const sparse = { id: 'x', name: 'x', lines: [{ id: 'l', tiles: [{ id: 't', moduleId: 'm' }] }] };
  const s = migrate(sparse);
  assert.equal(s.lines[0]!.mode, 'parallel');
  assert.equal(s.lines[0]!.bypassed, false);
  assert.deepEqual(s.lines[0]!.tiles[0]!.params, {});
  assert.equal(s.lines[0]!.tiles[0]!.collapsed, true);
});
