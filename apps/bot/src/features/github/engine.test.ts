import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_TEMPLATES } from '@discord-kit/config';
import { openDatabase } from '../../db.ts';
import type { Logger } from '../../log.ts';
import { profilesStore } from '../projects/profiles.ts';
import { projectsStore } from '../projects/store.ts';
import { SyncEngine, type ChangeEvent, type DiscordSide } from './engine.ts';
import { FakeGitHub } from './fake-github.ts';
import { githubStore } from './store.ts';

const dev = DEFAULT_TEMPLATES.dev!;
const ALL = '1970-01-01T00:00:00.000Z';
const later = () => new Date(Date.now() + 3 * 60_000);

function setup(opts: { syncFrom?: string } = {}) {
  const db = openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-engine-')));
  const projects = projectsStore(db);
  const repos = githubStore(db);
  const profiles = profilesStore(db);
  const project = projects.createProject({
    key: 'DK',
    name: 'discord-kit',
    template: 'dev',
    visibility: 'public',
    createdBy: 'u0',
    categoryId: 'c',
    forumId: 'f',
    boardId: 'b',
    activityId: 'a',
    roleId: 'r',
  });
  projects.addRepo(project.id, 'acme', 'web');
  const repoId = repos.addRepo(project.id, 'acme', 'web');
  repos.setSyncFrom(repoId, opts.syncFrom ?? ALL);
  const gh = new FakeGitHub();
  gh.install('acme/web');
  const calls = {
    posted: [] as string[],
    changes: [] as ChangeEvent[],
    refreshed: [] as string[],
    announced: [] as string[],
    notes: [] as string[],
    alerts: [] as { ticket?: string; text: string; ping?: string }[],
  };
  const discord: DiscordSide = {
    postTicket: async (_p, t) => void calls.posted.push(t.key),
    applyChange: async (_p, _t, e) => void calls.changes.push(e),
    refresh: async (_p, t) => void calls.refreshed.push(t.key),
    announce: async (_p, text) => void calls.announced.push(text),
    note: async (_t, text) => void calls.notes.push(text),
    alert: async (_p, ticket, text, ping) =>
      void calls.alerts.push({ ...(ticket && { ticket: ticket.key }), text, ...(ping && { ping }) }),
  };
  const errors: string[] = [];
  const log = { info() {}, warn() {}, error: (_s: string, m: string) => void errors.push(m) } as Logger;
  const engine = (now?: () => Date) =>
    new SyncEngine({
      client: gh,
      projects,
      repos,
      profiles,
      discord,
      templateFor: () => dev,
      prefix: 'status: ',
      log,
      ...(now && { now }),
    });
  return { projects, repos, profiles, project, repoId, gh, calls, errors, engine };
}

test('imports open issues once, with statuses from labels and one summary line', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'One' });
  s.gh.add('acme/web', { title: 'Two', labels: ['status: Testing'] });
  s.gh.add('acme/web', { title: 'Old', state: 'closed' });
  assert.equal(await s.engine().importRepo(s.repoId), 2);
  assert.equal(await s.engine().importRepo(s.repoId), 0);
  const tickets = s.projects.tickets(s.project.id);
  assert.deepEqual(
    tickets.map((t) => [t.title, t.status, t.issue?.number]),
    [
      ['One', 'todo', 1],
      ['Two', 'testing', 2],
    ],
  );
  assert.equal(s.calls.posted.length, 2);
  assert.deepEqual(s.calls.announced, ['📥 imported 2 issues from acme/web']);
});

test('"only new issues" skips issues created before the choice', async () => {
  const s = setup({ syncFrom: new Date().toISOString() });
  s.gh.add('acme/web', { title: 'Old backlog item' });
  assert.equal(await s.engine().importRepo(s.repoId), 0);
  await s.engine(later).pollRepo(s.repoId);
  assert.equal(s.projects.tickets(s.project.id).length, 0);
});

test('a poll applies a close on GitHub as the first done status', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'One' });
  await s.engine().importRepo(s.repoId);
  s.gh.edit('acme/web', 1, { state: 'closed' });
  const result = await s.engine(later).pollRepo(s.repoId);
  assert.equal(result.changed, 1);
  assert.equal(s.projects.tickets(s.project.id)[0]?.status, 'deployed');
  assert.deepEqual(s.calls.changes.at(-1), {
    type: 'status',
    from: 'todo',
    to: 'deployed',
    actor: '',
    origin: 'github',
  });
});

test('a poll right after a move in Discord leaves the move alone', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'One' });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  s.projects.setStatus(ticket.id, 'testing', 'u1', 'button');
  s.gh.edit('acme/web', 1, { title: 'One' });
  await s.engine().pollRepo(s.repoId);
  assert.equal(s.projects.ticket(ticket.id)?.status, 'testing');
});

test("the bot's own push does not come back as a change", async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'One' });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  const moved = s.projects.setStatus(ticket.id, 'deployed', 'u1', 'button')!;
  await s.engine().pushTicket(s.project, moved);
  assert.equal(s.gh.issue('acme/web', 1)?.state, 'closed');
  assert.deepEqual(s.gh.issue('acme/web', 1)?.labels, ['status: Deployed']);
  const before = s.calls.changes.length;
  await s.engine(later).pollRepo(s.repoId);
  assert.equal(s.calls.changes.length, before);
});

test('assignees map through profiles in both directions', async () => {
  const s = setup();
  s.profiles.setProfile('u1', { githubLogin: 'alice', email: null });
  s.gh.add('acme/web', { title: 'One', assignees: ['carol'] });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  s.gh.edit('acme/web', 1, { assignees: ['carol', 'alice'] });
  await s.engine(later).pollRepo(s.repoId);
  assert.deepEqual(s.projects.ticket(ticket.id)?.assignees, ['u1']);
  s.projects.removeAssignee(ticket.id, 'u1', 'u1', 'button');
  await s.engine().pushTicket(s.project, s.projects.ticket(ticket.id)!);
  assert.deepEqual(s.gh.issue('acme/web', 1)?.assignees, ['carol']);
});

test('GitHub assignees without a profile are kept on the ticket for display only', async () => {
  const s = setup();
  s.profiles.setProfile('u1', { githubLogin: 'alice', email: null });
  s.gh.add('acme/web', { title: 'One', assignees: ['carol', 'alice'] });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  assert.deepEqual(ticket.assignees, ['u1']);
  assert.deepEqual(ticket.unlinkedGithubLogins, ['carol']);

  // Only the unmatched login changes: the post is redrawn, no assignment event is made.
  s.gh.edit('acme/web', 1, { assignees: ['alice', 'dave'] });
  const changes = s.calls.changes.length;
  assert.deepEqual(await s.engine(later).pollRepo(s.repoId), { changed: 1, created: 0 });
  assert.deepEqual(s.projects.ticket(ticket.id)?.unlinkedGithubLogins, ['dave']);
  assert.deepEqual(s.projects.ticket(ticket.id)?.assignees, ['u1']);
  assert.equal(s.calls.changes.length, changes);
  assert.deepEqual(s.calls.refreshed, ['DK-1']);

  // Nothing new: no redraw.
  s.gh.edit('acme/web', 1, { title: 'One' });
  await s.engine(later).pollRepo(s.repoId);
  assert.deepEqual(s.calls.refreshed, ['DK-1']);

  // Unlinking the issue forgets them.
  s.projects.unlinkIssue(ticket.id);
  assert.deepEqual(s.projects.ticket(ticket.id)?.unlinkedGithubLogins, []);
});

test('an assignee without a GitHub username is noted once per ticket, and the issue is left alone', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'One' });
  s.gh.add('acme/web', { title: 'Two' });
  await s.engine().importRepo(s.repoId);
  const [one, two] = s.projects.tickets(s.project.id);
  s.projects.addAssignee(one!.id, 'u2', 'u1', 'command');
  await s.engine().pushTicket(s.project, s.projects.ticket(one!.id)!);
  s.projects.setStatus(one!.id, 'in_progress', 'u1', 'button');
  await s.engine().pushTicket(s.project, s.projects.ticket(one!.id)!);
  assert.deepEqual(s.gh.issue('acme/web', 1)?.assignees, []);
  assert.deepEqual(s.calls.notes, [
    '<@u2> has no GitHub username yet, so they are not assigned on acme/web#1; they can set it with `/profile edit`.',
  ]);

  // Another ticket gets its own note; a member with a profile gets none.
  s.profiles.setProfile('u1', { githubLogin: 'alice', email: null });
  s.projects.addAssignee(two!.id, 'u1', 'u1', 'button');
  s.projects.addAssignee(two!.id, 'u2', 'u1', 'command');
  await s.engine().pushTicket(s.project, s.projects.ticket(two!.id)!);
  assert.deepEqual(s.gh.issue('acme/web', 2)?.assignees, ['alice']);
  assert.equal(s.calls.notes.length, 2);
  assert.match(s.calls.notes[1]!, /^<@u2> .* acme\/web#2;/);
});

test('creating an issue notes assignees without a GitHub username', async () => {
  const s = setup();
  const ticket = s.projects.createTicket(
    s.project.id,
    { title: 'Local', body: '', status: 'todo', createdBy: 'u1' },
    'command',
  );
  s.projects.addAssignee(ticket.id, 'u2', 'u1', 'command');
  const number = await s.engine().createIssueFor(s.project, s.projects.ticket(ticket.id)!, 'acme', 'web');
  assert.deepEqual(s.gh.issue('acme/web', number)?.assignees, []);
  assert.equal(s.calls.notes.length, 1);
  assert.match(s.calls.notes[0]!, new RegExp(`^<@u2> .* acme/web#${number};`));
});

test('simultaneous creates and a poll link just one issue to a forum ticket', async () => {
  const s = setup();
  const ticket = s.projects.createTicket(
    s.project.id,
    { title: 'Forum post', body: 'First message', status: 'todo', createdBy: 'u1' },
    'system',
  );
  const engine = s.engine();
  const write = s.gh.createIssue.bind(s.gh);
  let signalCreated!: () => void;
  const created = new Promise<void>((resolve) => (signalCreated = resolve));
  let releaseCreate!: () => void;
  const release = new Promise<void>((resolve) => (releaseCreate = resolve));
  s.gh.createIssue = async (...args) => {
    const number = await write(...args);
    signalCreated();
    await release;
    return number;
  };
  const creation = engine.createIssueFor(s.project, ticket, 'acme', 'web');
  await created;
  const duplicate = engine.createIssueFor(s.project, ticket, 'Acme', 'Web');
  // A reload can construct a new engine before the old engine's POST completes.
  const poll = s.engine().pollRepo(s.repoId);
  await Promise.resolve();
  s.projects.setTitle(ticket.id, 'Renamed during creation', 'u1', 'system');
  releaseCreate();

  const [number, duplicateNumber, counts] = await Promise.all([creation, duplicate, poll]);
  assert.equal(duplicateNumber, number);
  assert.equal(counts.created, 0);
  assert.deepEqual(
    s.gh.writes.filter((write) => write.startsWith('create')),
    ['create acme/web'],
  );
  assert.equal(s.projects.tickets(s.project.id).length, 1);
  assert.equal(s.projects.ticket(ticket.id)?.issue?.number, number);
  const issue = s.gh.issue('acme/web', number);
  assert.equal(issue?.title, 'Renamed during creation');
  assert.equal(issue?.body, 'First message');
  assert.deepEqual(issue?.labels, ['status: Todo']);
});

test('an in-flight poll does not import an issue created for a deleted forum post', async () => {
  const s = setup();
  const ticket = s.projects.createTicket(
    s.project.id,
    { title: 'Forum post', body: 'First message', status: 'todo', createdBy: 'u1' },
    'system',
  );
  const write = s.gh.createIssue.bind(s.gh);
  let signalCreated!: () => void;
  const created = new Promise<void>((resolve) => (signalCreated = resolve));
  let releaseCreate!: () => void;
  const release = new Promise<void>((resolve) => (releaseCreate = resolve));
  s.gh.createIssue = async (...args) => {
    const number = await write(...args);
    signalCreated();
    await release;
    return number;
  };

  const creation = s.engine().createIssueFor(s.project, ticket, 'acme', 'web');
  const rejected = assert.rejects(creation, /will be closed on sync/);
  await created;
  s.projects.markDeleted(ticket.id, '', 'system');
  const poll = s.engine().pollRepo(s.repoId);
  await Promise.resolve();
  releaseCreate();

  await rejected;
  assert.equal((await poll).created, 0);
  assert.equal(s.projects.isIssueClosurePending(ticket.id), true);
  assert.equal(s.projects.tickets(s.project.id).length, 0);
  await s.engine().poll();
  assert.ok(s.gh.notPlanned.has('acme/web#1'));
});

test('a failed issue creation leaves the local ticket available for retry', async () => {
  const s = setup();
  const ticket = s.projects.createTicket(
    s.project.id,
    { title: 'Forum post', body: 'First message', status: 'todo', createdBy: 'u1' },
    'system',
  );
  const engine = s.engine();
  s.gh.failWrites = true;
  await assert.rejects(engine.createIssueFor(s.project, ticket, 'acme', 'web'));
  assert.equal(s.projects.ticket(ticket.id)?.issue, null);
  s.gh.failWrites = false;
  const number = await engine.createIssueFor(s.project, ticket, 'acme', 'web');
  assert.equal(s.projects.ticket(ticket.id)?.issue?.number, number);
});

test('a new issue on GitHub becomes a ticket on the next poll', async () => {
  const s = setup();
  await s.engine().importRepo(s.repoId);
  s.gh.add('acme/web', { title: 'Fresh', body: 'details' });
  const result = await s.engine(later).pollRepo(s.repoId);
  assert.equal(result.created, 1);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  assert.equal(ticket.body, 'details');
  assert.deepEqual(s.calls.posted, ['DK-1']);
});

test('a failed push is logged and noted in the ticket', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'One' });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  s.gh.failWrites = true;
  await s.engine().pushTicket(s.project, s.projects.setStatus(ticket.id, 'testing', 'u1', 'button')!);
  assert.equal(s.errors.length, 1);
  assert.match(s.calls.notes[0] ?? '', /Could not update GitHub/);
});

test('pushing a ticket whose issue is gone unlinks it', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'One' });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  s.gh.issues.set('acme/web', []);
  await s.engine().pushTicket(s.project, ticket);
  assert.equal(s.projects.ticket(ticket.id)?.issue, null);
  assert.match(s.calls.notes[0] ?? '', /no longer on GitHub/);
});

test('creates an issue for a ticket and links an existing one', async () => {
  const s = setup();
  const local = s.projects.createTicket(
    s.project.id,
    { title: 'Local', body: 'b', status: 'testing', createdBy: 'u1' },
    'command',
  );
  const number = await s.engine().createIssueFor(s.project, local, 'acme', 'web');
  assert.deepEqual(s.gh.issue('acme/web', number)?.labels, ['status: Testing']);
  assert.equal(s.projects.ticket(local.id)?.issue?.number, number);

  s.gh.add('acme/web', { title: 'On GitHub', labels: ['status: Ready for main'] });
  const other = s.projects.createTicket(
    s.project.id,
    { title: 'Draft', body: '', status: 'todo', createdBy: 'u1' },
    'command',
  );
  assert.equal(
    await s.engine().linkExisting(s.project, other, { owner: 'acme', name: 'web', number: 2 }),
    undefined,
  );
  assert.deepEqual(
    [s.projects.ticket(other.id)?.title, s.projects.ticket(other.id)?.status],
    ['On GitHub', 'ready'],
  );
  assert.match(
    (await s.engine().linkExisting(s.project, other, { owner: 'acme', name: 'web', number: 1 })) ?? '',
    /already linked/,
  );
  assert.match(
    (await s.engine().linkExisting(s.project, other, { owner: 'other', name: 'repo', number: 1 })) ?? '',
    /not a repo of/,
  );
});

test('a failing pull request is alerted once, in the linked ticket, pinging its author', async () => {
  const s = setup();
  s.profiles.setProfile('u1', { githubLogin: 'alice', email: null });
  s.gh.add('acme/web', { title: 'One' });
  await s.engine().importRepo(s.repoId);
  s.gh.addPull('acme/web', {
    number: 7,
    title: 'Fix one',
    body: 'Fixes #1',
    author: 'alice',
    checkRuns: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
  });
  await s.engine(later).pollRepo(s.repoId);
  assert.equal(s.calls.alerts.length, 1);
  assert.equal(s.calls.alerts[0]?.ticket, 'DK-1');
  assert.equal(s.calls.alerts[0]?.ping, 'u1');
  assert.match(s.calls.alerts[0]?.text ?? '', /CI failed.*test/);
  await s.engine(later).pollRepo(s.repoId);
  assert.equal(s.calls.alerts.length, 1);
});

test('alerts without a linked ticket go to the project, without a ping for unknown authors', async () => {
  const s = setup();
  await s.engine().importRepo(s.repoId);
  s.gh.addPull('acme/web', { number: 3, author: 'stranger', mergeableState: 'dirty' });
  await s.engine(later).pollRepo(s.repoId);
  assert.deepEqual(
    s.calls.alerts.map((a) => [a.ticket, a.ping]),
    [[undefined, undefined]],
  );
  assert.match(s.calls.alerts[0]?.text ?? '', /merge conflicts/);
});

test('CI passing again after a failure is alerted when the pull request changes', async () => {
  const s = setup();
  await s.engine().importRepo(s.repoId);
  s.gh.addPull('acme/web', {
    number: 4,
    checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'failure' }],
  });
  await s.engine(later).pollRepo(s.repoId);
  s.gh.editPull('acme/web', 4, {
    headSha: 'sha2',
    checkRuns: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
  });
  await s.engine(later).pollRepo(s.repoId);
  assert.deepEqual(
    s.calls.alerts.map((a) => a.text.slice(0, 1)),
    ['❌', '✅'],
  );
});

test('closes a linked issue as not planned after its Discord post is deleted', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'Open ticket' });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;

  assert.equal(s.projects.markDeleted(ticket.id, '', 'system'), true);
  assert.equal(s.projects.markDeleted(ticket.id, '', 'system'), false);
  await Promise.all([s.engine().poll(), s.engine().poll()]);

  assert.equal(s.gh.issue('acme/web', 1)?.state, 'closed');
  assert.ok(s.gh.notPlanned.has('acme/web#1'));
  assert.deepEqual(s.gh.writes, ['comment acme/web#1', 'update acme/web#1 state']);
  assert.deepEqual([...s.gh.comments.get('acme/web#1')!], ['Discord ticket `DK-1` was deleted.']);

  s.gh.edit('acme/web', 1, { state: 'open' });
  await s.engine().poll();
  assert.equal(await s.engine().importRepo(s.repoId), 0);
  assert.equal(s.projects.tickets(s.project.id).length, 0);
  assert.equal(s.gh.issue('acme/web', 1)?.state, 'open');
});

test('retries a failed deletion close without repeating its comment or reimporting the issue', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'Open ticket' });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  s.projects.markDeleted(ticket.id, '', 'reconcile');

  const close = s.gh.closeIssueNotPlanned.bind(s.gh);
  s.gh.closeIssueNotPlanned = async () => {
    throw new Error('temporary failure');
  };
  await s.engine().poll();
  assert.equal(s.gh.issue('acme/web', 1)?.state, 'open');
  assert.equal(s.projects.isIssueClosurePending(ticket.id), true);
  assert.equal(s.projects.tickets(s.project.id).length, 0);
  assert.deepEqual(s.errors, ['could not close acme/web#1 for deleted ticket DK-1']);

  s.gh.closeIssueNotPlanned = close;
  await s.engine().poll();
  assert.equal(s.projects.isIssueClosurePending(ticket.id), false);
  assert.deepEqual(s.gh.writes, ['comment acme/web#1', 'update acme/web#1 state']);
});

test('leaves a linked issue that was already closed unchanged', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'Open ticket' });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  s.gh.edit('acme/web', 1, { state: 'closed' });
  s.projects.markDeleted(ticket.id, '', 'system');

  await s.engine().poll();

  assert.deepEqual(s.gh.writes, []);
  assert.equal(s.projects.isIssueClosurePending(ticket.id), false);
});

test('does not close an issue linked only after its Discord ticket was deleted', async () => {
  const s = setup();
  const ticket = s.projects.createTicket(
    s.project.id,
    { title: 'Local ticket', body: '', status: 'todo', createdBy: 'u0' },
    'command',
  );
  s.projects.markDeleted(ticket.id, '', 'system');
  s.gh.add('acme/web', { title: 'New GitHub issue' });
  s.projects.linkIssue(ticket.id, 'acme', 'web', 1);

  await s.engine().poll();

  assert.deepEqual(s.gh.writes, []);
  assert.equal(s.gh.issue('acme/web', 1)?.state, 'open');
});

test('queues closure when a newly created GitHub issue arrives after Discord deletion', async () => {
  const s = setup();
  const ticket = s.projects.createTicket(
    s.project.id,
    { title: 'Local ticket', body: '', status: 'todo', createdBy: 'u0' },
    'command',
  );
  const create = s.gh.createIssue.bind(s.gh);
  s.gh.createIssue = async (...args) => {
    const number = await create(...args);
    s.projects.markDeleted(ticket.id, '', 'system');
    return number;
  };

  await assert.rejects(s.engine().createIssueFor(s.project, ticket, 'acme', 'web'), /will be closed on sync/);
  assert.equal(s.projects.isIssueClosurePending(ticket.id), true);
  await s.engine().poll();

  assert.equal(s.gh.issue('acme/web', 1)?.state, 'closed');
  assert.ok(s.gh.notPlanned.has('acme/web#1'));
  assert.equal(s.projects.tickets(s.project.id).length, 0);
});

test('waits for an in-flight ticket write before closing the issue after deletion', async () => {
  const s = setup();
  s.gh.add('acme/web', { title: 'Old title', labels: ['status: Todo'] });
  await s.engine().importRepo(s.repoId);
  const ticket = s.projects.tickets(s.project.id)[0]!;
  const changed = s.projects.setTitle(ticket.id, 'New title', 'u0', 'command')!;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  let releaseUpdate!: () => void;
  const release = new Promise<void>((resolve) => (releaseUpdate = resolve));
  const update = s.gh.updateIssue.bind(s.gh);
  s.gh.updateIssue = async (...args) => {
    if (args[3].title) {
      signalStarted();
      await release;
    }
    await update(...args);
  };

  const push = s.engine().pushTicket(s.project, changed);
  await started;
  s.projects.markDeleted(ticket.id, '', 'system');
  const sync = s.engine().poll();
  releaseUpdate();
  await Promise.all([push, sync]);

  assert.deepEqual(s.gh.writes, ['update acme/web#1 title', 'comment acme/web#1', 'update acme/web#1 state']);
  assert.equal(s.gh.issue('acme/web', 1)?.state, 'closed');
});
