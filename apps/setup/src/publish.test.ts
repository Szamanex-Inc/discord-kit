import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitContent } from './publish.ts';

test('short text is a single message', () => {
  assert.deepEqual(splitContent('# Title\n\nParagraph\n'), ['# Title\n\nParagraph']);
});

test('splits at paragraphs without losing content', () => {
  const paras = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'x'.repeat(40)}`);
  const chunks = splitContent(paras.join('\n\n'), 120);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 120));
  assert.deepEqual(chunks.join('\n\n').split('\n\n'), paras);
});

test('hard-splits a paragraph that is too long', () => {
  const chunks = splitContent('y'.repeat(250), 100);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [100, 100, 50],
  );
});
