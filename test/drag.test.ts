/**
 * Guards the drag contract.
 *
 * This exists because of a bug that no amount of synthetic-event testing in the
 * page could catch: a module drag set `effectAllowed = 'copy'` while the
 * between-lines drop target set `dropEffect = 'move'`. Real browsers cancel a
 * drop when those disagree — `dragover` still fires, so the target lights up
 * blue and looks live, but `drop` never arrives and the tile silently vanishes.
 * Synthetic DragEvents do not enforce the rule, so every test passed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginDrag, DRAG_MIME, type DragPayload } from '../web/src/lib/drag.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = join(HERE, '..', 'web', 'src', 'components');

/** Enough of a DragEvent for beginDrag. */
function fakeEvent() {
  const store: Record<string, string> = {};
  return {
    dataTransfer: {
      effectAllowed: '' as string,
      setData(type: string, value: string) {
        store[type] = value;
      },
      get data() {
        return store;
      },
    },
  };
}

test('a drag allows both copy and move', () => {
  for (const payload of [
    { kind: 'module', moduleId: 'decode' },
    { kind: 'tile', tileId: 't1', moduleId: 'decode' },
  ] as DragPayload[]) {
    const e = fakeEvent();
    beginDrag(e as never, payload);
    assert.equal(
      e.dataTransfer.effectAllowed,
      'copyMove',
      'a narrower effectAllowed lets a target pick a dropEffect that cancels the drop',
    );
  }
});

test('the payload survives the dataTransfer round trip', () => {
  const e = fakeEvent();
  beginDrag(e as never, { kind: 'module', moduleId: 'load-image' });
  assert.deepEqual(JSON.parse(e.dataTransfer.data[DRAG_MIME]!), {
    kind: 'module',
    moduleId: 'load-image',
  });
  // Some browsers refuse to start a drag without a text/plain fallback.
  assert.equal(e.dataTransfer.data['text/plain'], 'load-image');
});

test('no drag source is a form control', () => {
  // Chrome will not reliably start a native drag from a <button> or <input> —
  // the control's own mousedown handling wins and dragstart never fires. The
  // element looks correct, the handler is wired, and nothing happens.
  for (const name of readdirSync(COMPONENTS)) {
    if (!name.endsWith('.tsx')) continue;
    const src = readFileSync(join(COMPONENTS, name), 'utf8');
    // Find every JSX element that carries `draggable` and check its tag.
    for (const match of src.matchAll(/<([a-z]\w*)([^>]*?)draggable/gs)) {
      const tag = match[1]!;
      assert.equal(
        ['button', 'input', 'select', 'textarea', 'a'].includes(tag),
        false,
        `${name} makes a <${tag}> draggable — form controls do not start native drags`,
      );
    }
  }
});

test('no drop target sets an explicit dropEffect', () => {
  // Setting one is what caused the bug; the browser default already agrees
  // with a copyMove source, so there is nothing to gain by overriding it.
  for (const name of readdirSync(COMPONENTS)) {
    if (!name.endsWith('.tsx')) continue;
    const src = readFileSync(join(COMPONENTS, name), 'utf8');
    assert.equal(
      /dropEffect\s*=/.test(src),
      false,
      `${name} sets dropEffect — if it disagrees with effectAllowed the drop is cancelled silently`,
    );
  }
});
