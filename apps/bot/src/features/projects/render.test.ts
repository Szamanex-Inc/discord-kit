import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEMPLATES, type StatusSpec } from '@discord-kit/config';
import { activityLine, controlMessage, parseCustomId, postName, splitPostName } from './render.ts';
import type { Ticket } from './store.ts';

const dev = DEFAULT_TEMPLATES.dev!;
const simple = DEFAULT_TEMPLATES.simple!;

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 5,
  projectId: 1,
  number: 12,
  key: 'DK-12',
  title: 'Hot reload drops agent runs',
  body: '',
  status: 'todo',
  threadId: 't1',
  controlMessageId: 't1',
  deleted: false,
  createdBy: 'u1',
  createdAt: '',
  updatedAt: '',
  assignees: [],
  issue: null,
  unlinkedGithubLogins: [],
  bodyEdited: false,
  ...over,
});

function render(t: Ticket, template: StatusSpec[] = dev) {
  const { embeds, components } = controlMessage(t, template);
  const embed = embeds[0].toJSON();
  const field = (name: string) => embed.fields?.find((f) => f.name === name)?.value;
  const rows = components.map((c) => c.toJSON());
  const ids = rows.flatMap((r) => r.components.map((c) => ('custom_id' in c ? c.custom_id : '')));
  const select = rows[1]?.components[0] as { options?: { value: string; default?: boolean }[] } | undefined;
  return { embed, field, ids, select };
}

test('control message shows key, status, assignees and links', () => {
  const r = render(ticket({ status: 'in_progress', assignees: ['u1', 'u2'] }));
  assert.equal(r.embed.title, 'DK-12 · Hot reload drops agent runs');
  assert.equal(r.field('Status'), '🟨 In progress');
  assert.equal(r.field('Assignees'), '<@u1>, <@u2>');
  assert.equal(r.field('Links'), 'none');
  assert.equal(render(ticket()).field('Assignees'), 'nobody');
});

test('control message lists GitHub assignees without a profile and how to link them', () => {
  const hint = '*Set your GitHub username with `/profile edit` to link it.*';
  assert.equal(
    render(ticket({ assignees: ['u1'], unlinkedGithubLogins: ['carol', 'dave'] })).field('Assignees'),
    ['<@u1>', 'github: carol (not linked)', 'github: dave (not linked)', hint].join('\n'),
  );
  assert.equal(
    render(ticket({ unlinkedGithubLogins: ['carol'] })).field('Assignees'),
    `github: carol (not linked)\n${hint}`,
  );
});

test('control message shows the edited description of a hand-made post', () => {
  assert.equal(render(ticket({ body: 'Original' })).embed.description, undefined);
  assert.equal(render(ticket({ body: 'Edited', bodyEdited: true })).embed.description, 'Edited');
  assert.equal(render(ticket({ bodyEdited: true })).embed.description, '*Description cleared.*');
});

test('an unknown status is shown by its key', () => {
  assert.equal(render(ticket({ status: 'gone' })).field('Status'), 'unknown status `gone`');
});

test('buttons: take, leave and blocked, or unblock when blocked', () => {
  assert.deepEqual(render(ticket()).ids.slice(0, 3), ['ticket:take:5', 'ticket:leave:5', 'ticket:block:5']);
  assert.ok(render(ticket({ status: 'blocked' })).ids.includes('ticket:unblock:5'));
  assert.ok(!render(ticket({ status: 'blocked' })).ids.includes('ticket:block:5'));
});

test('no blocked button when the template has no blocked status', () => {
  const ids = render(ticket(), simple).ids;
  assert.ok(!ids.some((id) => id.includes('block')));
});

test('the move menu lists every status with the current one selected', () => {
  const r = render(ticket({ status: 'testing' }));
  assert.ok(r.ids.includes('ticket:move:5'));
  assert.deepEqual(
    r.select?.options?.map((o) => o.value),
    dev.map((s) => s.key),
  );
  assert.deepEqual(
    r.select?.options?.filter((o) => o.default).map((o) => o.value),
    ['testing'],
  );
});

test('post names carry the key and fit in 100 characters', () => {
  assert.equal(postName(ticket()), 'DK-12 · Hot reload drops agent runs');
  const long = postName(ticket({ title: 'x'.repeat(200) }));
  assert.equal(long.length, 100);
  assert.ok(long.startsWith('DK-12 · ') && long.endsWith('…'));
});

test('splits the key off a post name', () => {
  assert.equal(splitPostName('DK-12 · Fix it', 'DK-12'), 'Fix it');
  assert.equal(splitPostName('dk-12 - Fix it', 'DK-12'), 'Fix it');
  assert.equal(splitPostName('DK-12:  Fix it', 'DK-12'), 'Fix it');
  assert.equal(splitPostName('Fix it', 'DK-12'), 'Fix it');
});

test('activity lines describe the change without pinging', () => {
  const base = { key: 'DK-12', title: 'Fix it', actor: 'u1' };
  assert.equal(
    activityLine({ ...base, type: 'created', to: 'todo' }, dev),
    '🆕 **DK-12** Fix it · created by <@u1>',
  );
  assert.equal(
    activityLine({ ...base, type: 'status', from: 'todo', to: 'in_progress' }, dev),
    '🟨 **DK-12** Fix it → In progress · <@u1>',
  );
  assert.equal(
    activityLine({ ...base, type: 'assigned', to: 'u1' }, dev),
    '👤 **DK-12** Fix it · taken by <@u1>',
  );
  assert.equal(
    activityLine({ ...base, type: 'assigned', to: 'u2' }, dev),
    '👤 **DK-12** Fix it · <@u1> assigned <@u2>',
  );
  assert.equal(
    activityLine({ ...base, type: 'unassigned', from: 'u1' }, dev),
    '👋 **DK-12** Fix it · <@u1> left',
  );
  assert.equal(
    activityLine({ ...base, type: 'title', to: 'Fix it' }, dev),
    '✏️ **DK-12** renamed to Fix it · <@u1>',
  );
  assert.equal(activityLine({ ...base, type: 'deleted' }, dev), '🗑️ **DK-12** Fix it · deleted');
});

test('parses ticket component ids', () => {
  assert.deepEqual(parseCustomId('ticket:move:7'), { action: 'move', ticketId: 7 });
  assert.deepEqual(parseCustomId('ticket:blockreason:3'), { action: 'blockreason', ticketId: 3 });
  assert.equal(parseCustomId('ticket:explode:3'), undefined);
  assert.equal(parseCustomId('rolepicker:0'), undefined);
});

test('shows the description only when asked', () => {
  const t = ticket({ body: 'Steps to reproduce' });
  assert.equal(controlMessage(t, dev).embeds[0].toJSON().description, undefined);
  assert.equal(
    controlMessage(t, dev, { showBody: true }).embeds[0].toJSON().description,
    'Steps to reproduce',
  );
  assert.equal(controlMessage(ticket(), dev, { showBody: true }).embeds[0].toJSON().description, undefined);
});

test('activity lines for edits made in Discord name no one', () => {
  assert.equal(
    activityLine(
      { key: 'DK-12', title: 'Fix it', type: 'status', from: 'todo', to: 'testing', actor: '' },
      dev,
    ),
    '🟪 **DK-12** Fix it → Testing · changed in Discord',
  );
  assert.equal(
    activityLine({ key: 'DK-12', title: 'Fix it', type: 'deleted', actor: '' }, dev),
    '🗑️ **DK-12** Fix it · deleted',
  );
});

test('the links field shows the linked issue', () => {
  const t = ticket({ issue: { owner: 'acme', name: 'web', number: 42 } });
  const links = controlMessage(t, dev)
    .embeds[0].toJSON()
    .fields?.find((f) => f.name === 'Links')?.value;
  assert.equal(links, '[acme/web#42](https://github.com/acme/web/issues/42)');
});

test('activity lines for changes from GitHub say so', () => {
  const base = { key: 'DK-12', title: 'Fix it', actor: '', origin: 'github' as const };
  assert.equal(
    activityLine({ ...base, type: 'created', to: 'todo' }, dev),
    '🆕 **DK-12** Fix it · created on GitHub',
  );
  assert.equal(
    activityLine({ ...base, type: 'status', from: 'todo', to: 'testing' }, dev),
    '🟪 **DK-12** Fix it → Testing · changed on GitHub',
  );
  assert.equal(
    activityLine({ ...base, type: 'assigned', to: 'u1' }, dev),
    '👤 **DK-12** Fix it · <@u1> assigned on GitHub',
  );
  assert.equal(
    activityLine({ ...base, type: 'unassigned', from: 'u1' }, dev),
    '👋 **DK-12** Fix it · <@u1> unassigned on GitHub',
  );
  assert.equal(
    activityLine({ ...base, type: 'title', to: 'Fix it' }, dev),
    '✏️ **DK-12** renamed to Fix it · changed on GitHub',
  );
});
