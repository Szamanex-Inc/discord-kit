import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecentEdits } from './recent-edits.ts';

test('recognizes a state the bot applied, in any tag order', () => {
  const edits = new RecentEdits();
  edits.record('t1', ['a', 'b'], 'DK-1 · Fix');
  assert.equal(edits.isRecent('t1', ['b', 'a'], 'DK-1 · Fix'), true);
  assert.equal(edits.isRecent('t1', ['a'], 'DK-1 · Fix'), false);
  assert.equal(edits.isRecent('t1', ['a', 'b'], 'DK-1 · Other'), false);
  assert.equal(edits.isRecent('t2', ['a', 'b'], 'DK-1 · Fix'), false);
});

test('remembers several states, so a late update from an earlier move is still recognized', () => {
  const edits = new RecentEdits();
  edits.record('t1', ['todo'], 'n');
  edits.record('t1', ['testing'], 'n');
  assert.equal(edits.isRecent('t1', ['todo'], 'n'), true);
  assert.equal(edits.isRecent('t1', ['testing'], 'n'), true);
});

test('forgets states after the time to live', () => {
  let now = 1000;
  const edits = new RecentEdits(() => now, 30_000);
  edits.record('t1', ['a'], 'n');
  now += 30_001;
  assert.equal(edits.isRecent('t1', ['a'], 'n'), false);
});
