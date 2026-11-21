import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveFlag } from './manager.ts';

test('uses the preset value without override or kill switch', () => {
  assert.deepEqual(resolveFlag(true, undefined, false), { enabled: true, source: 'preset' });
  assert.deepEqual(resolveFlag(false, undefined, false), { enabled: false, source: 'preset' });
});

test('override wins over the preset', () => {
  assert.deepEqual(resolveFlag(false, true, false), { enabled: true, source: 'override' });
  assert.deepEqual(resolveFlag(true, false, false), { enabled: false, source: 'override' });
});

test('kill switch wins over everything', () => {
  assert.deepEqual(resolveFlag(true, true, true), { enabled: false, source: 'kill switch' });
});
