import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../../db.ts';
import { projectsStore } from './store.ts';

function setup() {
  const store = projectsStore(openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-tickets-'))));
  const channels = { categoryId: 'c', forumId: 'f', boardId: 'b', activityId: 'a', roleId: 'r' };
  const dk = store.createProject({
    key: 'DK',
    name: 'discord-kit',
    template: 'dev',
    visibility: 'public',
    createdBy: 'u1',
    ...channels,
  });
  const other = store.createProject({
    key: 'MUR',
    name: 'murmur',
    template: 'dev',
    visibility: 'public',
    createdBy: 'u1',
    ...channels,
    categoryId: 'c2',
  });
  const newTicket = (projectId = dk.id, title = 'Fix it') =>
    store.createTicket(projectId, { title, body: '', status: 'todo', createdBy: 'u1' }, 'command');
  return { store, dk, other, newTicket };
}

test('numbers tickets per project and never reuses numbers', () => {
  const { store, dk, other, newTicket } = setup();
  const a = newTicket();
  const b = newTicket();
  const m = newTicket(other.id);
  assert.deepEqual([a.key, b.key, m.key], ['DK-1', 'DK-2', 'MUR-1']);
  store.markDeleted(b.id, 'u1', 'system');
  assert.equal(newTicket().key, 'DK-3');
  assert.equal(store.project(dk.id)?.key, 'DK');
});

test('logs every change with its source', () => {
  const { store, newTicket } = setup();
  const t = newTicket();
  store.setStatus(t.id, 'in_progress', 'u2', 'button');
  store.addAssignee(t.id, 'u2', 'u2', 'button');
  store.setTitle(t.id, 'Fix it properly', 'u3', 'title-edit');
  assert.deepEqual(
    store.events(t.id).map((e) => [e.type, e.fromValue, e.toValue, e.actor, e.source]),
    [
      ['created', null, 'todo', 'u1', 'command'],
      ['status', 'todo', 'in_progress', 'u2', 'button'],
      ['assigned', null, 'u2', 'u2', 'button'],
      ['title', 'Fix it', 'Fix it properly', 'u3', 'title-edit'],
    ],
  );
  assert.equal(store.ticket(t.id)?.title, 'Fix it properly');
});

test('setting the same status changes nothing', () => {
  const { store, newTicket } = setup();
  const t = newTicket();
  assert.equal(store.setStatus(t.id, 'todo', 'u2', 'button'), undefined);
  assert.equal(store.events(t.id).length, 1);
});

test('statusBefore returns the status a ticket had before it was blocked', () => {
  const { store, newTicket } = setup();
  const t = newTicket();
  store.setStatus(t.id, 'in_progress', 'u1', 'button');
  store.setStatus(t.id, 'blocked', 'u1', 'button');
  assert.equal(store.statusBefore(t.id, 'blocked'), 'in_progress');
  assert.equal(store.statusBefore(t.id, 'testing'), undefined);
});

test('assignees are a set', () => {
  const { store, newTicket } = setup();
  const t = newTicket();
  assert.equal(store.addAssignee(t.id, 'u2', 'u2', 'button'), true);
  assert.equal(store.addAssignee(t.id, 'u2', 'u2', 'button'), false);
  assert.equal(store.addAssignee(t.id, 'u3', 'u2', 'command'), true);
  assert.deepEqual(store.ticket(t.id)?.assignees, ['u2', 'u3']);
  assert.equal(store.removeAssignee(t.id, 'u2', 'u2', 'button'), true);
  assert.equal(store.removeAssignee(t.id, 'u2', 'u2', 'button'), false);
  assert.deepEqual(store.ticket(t.id)?.assignees, ['u3']);
});

test('finds tickets by key, thread and assignee', () => {
  const { store, newTicket } = setup();
  const t = newTicket();
  store.attachThread(t.id, 'thread1', 'msg1');
  store.addAssignee(t.id, 'u9', 'u9', 'button');
  assert.equal(store.ticketByKey('dk-1')?.id, t.id);
  assert.equal(store.ticketByKey('DK-99'), undefined);
  assert.equal(store.ticketByThread('thread1')?.controlMessageId, 'msg1');
  assert.deepEqual(
    store.ticketsAssignedTo('u9').map((x) => x.key),
    ['DK-1'],
  );
});

test('filters lists and hides deleted tickets by default', () => {
  const { store, dk, newTicket } = setup();
  const a = newTicket();
  const b = newTicket();
  store.setStatus(b.id, 'testing', 'u1', 'button');
  store.markDeleted(a.id, 'u1', 'system');
  assert.deepEqual(
    store.tickets(dk.id).map((x) => x.key),
    ['DK-2'],
  );
  assert.deepEqual(
    store.tickets(dk.id, { includeDeleted: true }).map((x) => x.key),
    ['DK-1', 'DK-2'],
  );
  assert.deepEqual(
    store.tickets(dk.id, { status: 'todo' }).map((x) => x.key),
    [],
  );
});

test('links a ticket to an issue and finds it back ignoring case', () => {
  const { store, newTicket } = setup();
  const t = newTicket();
  assert.equal(store.ticket(t.id)?.issue, null);
  store.linkIssue(t.id, 'acme', 'web', 42);
  assert.deepEqual(store.ticket(t.id)?.issue, { owner: 'acme', name: 'web', number: 42 });
  assert.deepEqual(store.issueOf(t.id), { owner: 'acme', name: 'web', number: 42 });
  assert.equal(store.ticketByIssue('ACME', 'Web', 42)?.id, t.id);
  assert.equal(store.ticketByIssue('acme', 'web', 43), undefined);
  store.unlinkIssue(t.id);
  assert.equal(store.issueOf(t.id), undefined);
  assert.equal(store.ticketByIssue('acme', 'web', 42), undefined);
});

test('the last change made in Discord ignores changes from GitHub', () => {
  const { store, newTicket } = setup();
  const t = newTicket();
  const created = store.lastLocalChangeAt(t.id);
  assert.ok(created);
  store.setStatus(t.id, 'testing', '', 'github');
  assert.equal(store.lastLocalChangeAt(t.id), created);
  store.setStatus(t.id, 'ready', 'u1', 'button');
  assert.notEqual(store.lastLocalChangeAt(t.id), undefined);
  assert.equal(store.events(t.id).at(-1)?.source, 'button');
});
