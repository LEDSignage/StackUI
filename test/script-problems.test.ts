/**
 * The shot list's timing warnings.
 *
 * A shot entered as "2 to 2" is a zero-length shot at the two second mark. The
 * model does not complain, ComfyUI does not complain, and the clip comes back
 * with that section smeared or repeated — with nothing anywhere saying why.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problems } from '../web/src/components/ScriptEditor.tsx';
import type { Script } from '../shared/types.ts';

const script = (shots: [number, number][]): Script => ({
  target: { tileId: 't', param: 'prompt' },
  vision: '',
  shots: shots.map(([from, to]) => ({ from, to, text: 'x' })),
});

test('a clean run of shots has nothing to say', () => {
  assert.deepEqual(problems(script([[0, 2], [2, 4], [4, 5]])), []);
});

test('a zero-length shot is called out', () => {
  const out = problems(script([[0, 2], [2, 2], [4, 5]]));
  assert.ok(out.some((p) => /Shot 2 has no length/.test(p)), out.join(' | '));
});

test('a gap is called out, with the range', () => {
  const out = problems(script([[0, 2], [4, 5]]));
  assert.ok(out.some((p) => p.includes('2s–4s')), out.join(' | '));
});

test('a late start is a gap too', () => {
  const out = problems(script([[1.5, 3]]));
  assert.ok(out.some((p) => p.includes('0s–1.5s')), out.join(' | '));
});

test('overlapping shots are called out', () => {
  const out = problems(script([[0, 3], [2, 4]]));
  assert.ok(out.some((p) => /before the previous one ends/.test(p)), out.join(' | '));
});

test('an empty script says nothing', () => {
  assert.deepEqual(problems(script([])), []);
});

test('the real script that produced the bad clip is caught', () => {
  // 0-2, then 2-2, then 4-5: a zero-length shot AND a two second hole.
  const out = problems(script([[0, 2], [2, 2], [4, 5]]));
  assert.equal(out.length, 2, out.join(' | '));
});
