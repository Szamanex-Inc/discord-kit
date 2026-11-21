import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATES } from '@discord-kit/config';
import {
  issueAssigneesFor,
  labelsForStatus,
  parseIssueRef,
  stateFromIssue,
  ticketAssigneesFor,
  withinGrace,
} from './sync.ts';

const dev = DEFAULT_TEMPLATES.dev!;
const P = 'status: ';
const issue = (state: 'open' | 'closed', labels: string[] = [], title = 'Fix it') => ({
  title,
  state,
  labels,
});

test('an open issue takes its status label', () => {
  assert.deepEqual(stateFromIssue(issue('open', ['bug', 'status: Testing']), dev, P, 'todo'), {
    title: 'Fix it',
    status: 'testing',
  });
});

test('an open issue without a status label keeps the status, unless it was done', () => {
  assert.equal(stateFromIssue(issue('open'), dev, P, 'testing').status, 'testing');
  assert.equal(stateFromIssue(issue('open'), dev, P, 'deployed').status, 'todo');
});

test('a closed issue goes to its done status label, else the first done status', () => {
  assert.equal(stateFromIssue(issue('closed', ['status: Deployed']), dev, P, 'testing').status, 'deployed');
  assert.equal(stateFromIssue(issue('closed', ['status: Testing']), dev, P, 'testing').status, 'deployed');
  assert.equal(stateFromIssue(issue('closed'), dev, P, 'blocked').status, 'deployed');
});

test('a closed issue keeps the status when the template has no done status', () => {
  const noDone = [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
  ];
  assert.equal(stateFromIssue(issue('closed'), noDone, P, 'b').status, 'b');
});

test('labels for a status keep other labels and replace status labels', () => {
  assert.deepEqual(labelsForStatus(['bug', 'status: Todo', 'ui'], 'testing', dev, P), [
    'bug',
    'ui',
    'status: Testing',
  ]);
  assert.deepEqual(labelsForStatus([], 'todo', dev, P), ['status: Todo']);
});

test('issue assignees keep unknown logins and add mapped ticket assignees', () => {
  const loginOf = (id: string) => ({ u1: 'alice', u2: 'bob' })[id];
  const known = (login: string) => ['alice', 'bob'].includes(login.toLowerCase());
  assert.deepEqual(issueAssigneesFor(['carol', 'Alice'], ['u2'], loginOf, known), ['carol', 'bob']);
  assert.deepEqual(issueAssigneesFor(['carol'], ['u1', 'u9'], loginOf, known), ['carol', 'alice']);
});

test('ticket assignees come from mapped logins plus members without a profile', () => {
  const userOf = (login: string) => ({ alice: 'u1', bob: 'u2' })[login.toLowerCase()];
  const hasProfile = (id: string) => ['u1', 'u2'].includes(id);
  assert.deepEqual(ticketAssigneesFor(['Alice', 'carol'], ['u2', 'u9'], userOf, hasProfile), ['u1', 'u9']);
});

test('changes made in Discord in the last 2 minutes are protected', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  assert.equal(withinGrace('2026-11-16T11:59:00Z', now), true);
  assert.equal(withinGrace('2026-11-16T11:57:00Z', now), false);
  assert.equal(withinGrace(undefined, now), false);
});

test('parses issue references', () => {
  const acme = { owner: 'acme', name: 'web', number: 42 };
  assert.deepEqual(parseIssueRef('acme/web#42'), acme);
  assert.deepEqual(parseIssueRef('https://github.com/acme/web/issues/42'), acme);
  assert.equal(parseIssueRef('#42'), undefined);
  assert.equal(parseIssueRef('acme/web'), undefined);
});
