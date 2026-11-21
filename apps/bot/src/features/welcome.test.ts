import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWelcome } from './welcome.ts';

test('fills every placeholder, repeatedly', () => {
  const out = renderWelcome('Hi {user} ({name})! {server} has {member_count} members. Bye {name}.', {
    mention: '<@1>',
    name: 'Ann',
    server: 'Club',
    memberCount: 42,
  });
  assert.equal(out, 'Hi <@1> (Ann)! Club has 42 members. Bye Ann.');
});
