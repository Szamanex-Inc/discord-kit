import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATES } from '@discord-kit/config';
import { statusFromLabels, statusLabels } from './labels.ts';

const dev = DEFAULT_TEMPLATES.dev!;

test('one label per status, with the prefix and a color', () => {
  const labels = statusLabels(dev, 'status: ');
  assert.deepEqual(
    labels.map((l) => l.name),
    dev.map((s) => `status: ${s.label}`),
  );
  assert.ok(labels.every((l) => /^[0-9a-f]{6}$/.test(l.color)));
  assert.equal(labels[0]?.key, 'todo');
});

test('labels fit in 50 characters and stay unique', () => {
  const long = [
    { key: 'a', label: 'x'.repeat(20) },
    { key: 'b', label: 'x'.repeat(19) + 'y' },
  ];
  const labels = statusLabels(long, 'p'.repeat(40));
  assert.ok(labels.every((l) => l.name.length <= 50));
  assert.equal(new Set(labels.map((l) => l.name)).size, 2);
});

test('reads the status from issue labels', () => {
  assert.equal(statusFromLabels(['bug', 'Status: Testing'], dev, 'status: '), 'testing');
  assert.equal(statusFromLabels(['bug'], dev, 'status: '), undefined);
  assert.equal(statusFromLabels(['status: Gone'], dev, 'status: '), undefined);
});
