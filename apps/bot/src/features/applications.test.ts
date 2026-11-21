import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, fill, format, staffTexts, texts } from './applications.ts';

const base = { channel: 'a', review_channel: 'b', questions: [{ label: 'Who are you?' }] };

test('uses defaults for missing texts and keeps configured ones', () => {
  const t = texts({ ...base, button_label: 'Aplikuj' });
  assert.equal(t.button_label, 'Aplikuj');
  assert.equal(t.form_title, 'Application');
});

test('fills placeholders', () => {
  assert.equal(
    fill('Hi {name}, welcome to {server}', { name: 'Ann', server: 'Club' }),
    'Hi Ann, welcome to Club',
  );
});

test('clips long answers to the embed field limit', () => {
  assert.equal(clip('x'.repeat(2000)).length, 1024);
  assert.equal(clip('short'), 'short');
});

test('staff texts default to English and accept overrides', () => {
  const st = staffTexts({ ...base, staff_texts: { accept_label: 'Przyjmij' } });
  assert.equal(st.accept_label, 'Przyjmij');
  assert.equal(st.reject_label, 'Reject');
});

test('formats known placeholders and keeps unknown ones', () => {
  assert.equal(format('#{id} by {reviewer} {other}', { id: 7, reviewer: 'Ann' }), '#7 by Ann {other}');
});
