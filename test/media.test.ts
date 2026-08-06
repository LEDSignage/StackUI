/**
 * The delete endpoint must only ever reach files in the output folder.
 *
 * This is the one place Stack UI removes something from disk on request, so the
 * check is worth pinning down. Screening the input for ".." would pass every
 * case below except the obvious one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { insideOutput } from '../shared/outputPath.ts';

const OUT = resolve('C:/Comfy/output');

test('an ordinary file resolves', () => {
  assert.equal(insideOutput(OUT, '', 'clip_00004_.mp4'), resolve(OUT, 'clip_00004_.mp4'));
});

test('a subfolder resolves', () => {
  assert.equal(insideOutput(OUT, 'renders', 'a.png'), resolve(OUT, 'renders', 'a.png'));
});

test('climbing out is refused', () => {
  assert.equal(insideOutput(OUT, '..', 'secret.txt'), null);
  assert.equal(insideOutput(OUT, '', '../secret.txt'), null);
  assert.equal(insideOutput(OUT, 'renders/../..', 'secret.txt'), null);
  assert.equal(insideOutput(OUT, '', '..\\..\\Windows\\System32\\drivers\\etc\\hosts'), null);
});

test('an absolute path is refused', () => {
  assert.equal(insideOutput(OUT, '', 'C:/Windows/System32/notepad.exe'), null);
  assert.equal(insideOutput(OUT, 'C:/Windows', 'notepad.exe'), null);
});

test('the folder itself is refused', () => {
  assert.equal(insideOutput(OUT, '', ''), null);
  assert.equal(insideOutput(OUT, '', '.'), null);
});

test('a sibling folder with the same prefix is refused', () => {
  // resolve() gives "C:\Comfy\output-old\x.png", which startsWith the root
  // string but is a different folder — hence the separator in the check.
  assert.equal(insideOutput(OUT, '', '../output-old/x.png'), null);
});
