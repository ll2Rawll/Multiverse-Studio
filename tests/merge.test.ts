import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyResolutions, diff3Lines, mergeText } from '../src/engine/merge/diff3';
import { splitLines } from '../src/engine/merge/text';

const lines = (...xs: string[]): string => xs.map((x) => `${x}\n`).join('');

test('splitLines keeps terminators so joining is lossless', () => {
  for (const text of ['', 'a', 'a\n', 'a\r\nb', 'a\rb\n', '\n\n']) {
    assert.equal(splitLines(text).join(''), text);
  }
});

test('non-overlapping changes from both sides merge cleanly', () => {
  const base = lines('one', 'two', 'three', 'four', 'five');
  const ours = lines('ONE', 'two', 'three', 'four', 'five');
  const theirs = lines('one', 'two', 'three', 'four', 'FIVE');
  const result = mergeText(base, ours, theirs);
  assert.equal(result.clean, true);
  assert.equal(result.text, lines('ONE', 'two', 'three', 'four', 'FIVE'));
});

test('overlapping different changes conflict and keep both sides', () => {
  const base = lines('a', 'Plan work that ships', 'c');
  const ours = lines('a', 'Built for independent makers', 'c');
  const theirs = lines('a', 'Built for growing teams', 'c');
  const result = mergeText(base, ours, theirs);
  assert.equal(result.clean, false);
  assert.equal(result.conflictCount, 1);
  const conflict = result.chunks.find((c) => c.kind === 'conflict');
  assert.ok(conflict && conflict.kind === 'conflict');
  assert.deepEqual(conflict.ours, ['Built for independent makers\n']);
  assert.deepEqual(conflict.theirs, ['Built for growing teams\n']);
  assert.deepEqual(conflict.base, ['Plan work that ships\n']);
});

test('identical changes on both sides are not conflicts', () => {
  const base = lines('a', 'b', 'c');
  const both = lines('a', 'B', 'c');
  assert.deepEqual(mergeText(base, both, both), { clean: true, text: both, chunks: [{ kind: 'stable', lines: splitLines(both) }], conflictCount: 0 });
  const ours = lines('a', 'B', 'c', 'd');
  const theirs = lines('x', 'a', 'B', 'c');
  const r = mergeText(base, ours, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.text, lines('x', 'a', 'B', 'c', 'd'));
});

test('adjacent edits are treated as conflicts (never silently interleaved)', () => {
  const base = lines('a', 'b', 'c');
  const ours = lines('a', 'B', 'c');
  const theirs = lines('a', 'b', 'C');
  assert.equal(mergeText(base, ours, theirs).clean, false);
});

test('insertions at the same place conflict unless equal', () => {
  const base = lines('a', 'c');
  const r = diff3Lines(splitLines(base), splitLines(lines('a', 'x', 'c')), splitLines(lines('a', 'y', 'c')));
  assert.equal(r.filter((c) => c.kind === 'conflict').length, 1);
});

test('resolutions produce the chosen text', () => {
  const base = lines('a', 'b', 'c');
  const ours = lines('a', 'ours', 'c');
  const theirs = lines('a', 'theirs', 'c');
  const { chunks } = mergeText(base, ours, theirs);
  assert.equal(applyResolutions(chunks, {}), null);
  assert.equal(applyResolutions(chunks, { 0: { choice: 'ours' } }), ours);
  assert.equal(applyResolutions(chunks, { 0: { choice: 'theirs' } }), theirs);
  assert.equal(applyResolutions(chunks, { 0: { choice: 'ours-then-theirs' } }), lines('a', 'ours', 'theirs', 'c'));
  assert.equal(applyResolutions(chunks, { 0: { choice: 'custom', text: 'both\n' } }), lines('a', 'both', 'c'));
});

test('a large file with a few edits merges quickly', () => {
  const base = Array.from({ length: 20000 }, (_, i) => `line ${i}\n`);
  const ours = [...base];
  const theirs = [...base];
  ours[100] = 'ours\n';
  theirs[19000] = 'theirs\n';
  const start = Date.now();
  const r = mergeText(base.join(''), ours.join(''), theirs.join(''));
  assert.equal(r.clean, true);
  assert.ok(Date.now() - start < 2000);
});
