import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Collection, type ModalBuilder, type ModalSubmitInteraction } from 'discord.js';
import { openDatabase } from '../../db.ts';
import type { FeatureContext } from '../../feature.ts';
import { githubHooks } from './hooks.ts';
import { projectsStore } from './store.ts';
import { handleTicketEdit, ticketCommand } from './ticket-commands.ts';

function setup(body = 'Original description') {
  const db = openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-ticket-edit-')));
  const ctx = {
    db,
    preset: { config: {} },
    guild: { channels: { cache: new Map() } },
    log: { warn() {} },
  } as unknown as FeatureContext;
  const store = projectsStore(db);
  const project = store.createProject({
    key: 'DK',
    name: 'discord-kit',
    template: 'dev',
    visibility: 'private',
    categoryId: 'c',
    forumId: 'f',
    boardId: 'b',
    activityId: 'a',
    roleId: 'r',
    createdBy: 'u1',
  });
  const ticket = store.createTicket(
    project.id,
    { title: 'Original title', body, status: 'todo', createdBy: 'u1' },
    'system',
  );
  store.linkIssue(ticket.id, 'owner', 'repo', 12);
  const member = (allowed: boolean) => ({
    permissions: { has: () => false },
    roles: { cache: new Collection(allowed ? [[project.roleId, { name: 'Project' }]] : []) },
  });
  return {
    store,
    ticket,
    async open(allowed = true) {
      let modal: ModalBuilder | undefined;
      let reply: string | undefined;
      const interaction = {
        member: member(allowed),
        options: { getSubcommand: () => 'edit', getString: () => ticket.key },
        showModal(form: ModalBuilder) {
          modal = form;
        },
        reply(value: { content: string }) {
          reply = value.content;
        },
      } as unknown as Parameters<ReturnType<typeof ticketCommand>['execute']>[0];
      await ticketCommand().execute(interaction, ctx);
      return { modal: modal?.toJSON(), reply };
    },
    async submit(customId: string, title: string, description: string, allowed = true) {
      let reply: string | undefined;
      const interaction = {
        customId,
        user: { id: 'u1' },
        member: member(allowed),
        fields: { getTextInputValue: (field: string) => (field === 'title' ? title : description) },
        deferReply() {},
        editReply(value: string | { content: string }) {
          reply = typeof value === 'string' ? value : value.content;
        },
      } as unknown as ModalSubmitInteraction<'cached'>;
      assert.equal(await handleTicketEdit(interaction, ctx), true);
      return reply;
    },
  };
}

test('checks project membership when opening and submitting a ticket edit', async () => {
  const s = setup();
  const denied = await s.open(false);
  assert.equal(denied.modal, undefined);
  assert.match(denied.reply!, /Only members/);
  const { modal } = await s.open();
  assert.equal(modal?.title, 'Edit DK-1');
  assert.match(
    (await s.submit(modal!.custom_id, 'New title', 'New description', false)) ?? '',
    /Only members/,
  );
  assert.equal(s.store.ticket(s.ticket.id)?.body, s.ticket.body);
});

test('logs description edits locally, syncs title edits, and rejects a stale form', async (t) => {
  const s = setup();
  const previous = githubHooks.ticketChanged;
  const pushes = t.mock.fn(() => {});
  githubHooks.ticketChanged = pushes;
  t.after(() => {
    if (previous) githubHooks.ticketChanged = previous;
    else delete githubHooks.ticketChanged;
  });
  const { modal } = await s.open();
  const customId = modal!.custom_id;
  assert.match((await s.submit(customId, s.ticket.title, 'New description')) ?? '', /Updated/);
  assert.equal(s.store.ticket(s.ticket.id)?.body, 'New description');
  assert.equal(s.store.ticket(s.ticket.id)?.bodyEdited, true);
  assert.equal(pushes.mock.callCount(), 0);
  assert.match((await s.submit(customId, 'Lost update', '')) ?? '', /while this form was open/);

  const fresh = await s.open();
  assert.match((await s.submit(fresh.modal!.custom_id, 'New title', '')) ?? '', /Updated/);
  assert.equal(s.store.ticket(s.ticket.id)?.title, 'New title');
  assert.equal(s.store.ticket(s.ticket.id)?.body, '');
  assert.equal(pushes.mock.callCount(), 1);
  assert.deepEqual(
    s.store.events(s.ticket.id).map((event) => event.type),
    ['created', 'description', 'title', 'description'],
  );
});

test('keeps an imported body longer than the form allows when changing only its title', async () => {
  const original = 'x'.repeat(4100);
  const s = setup(original);
  const { modal } = await s.open();
  assert.match((await s.submit(modal!.custom_id, 'New title', original.slice(0, 4000))) ?? '', /Updated/);
  assert.equal(s.store.ticket(s.ticket.id)?.body, original);
  assert.equal(s.store.ticket(s.ticket.id)?.bodyEdited, false);
});
