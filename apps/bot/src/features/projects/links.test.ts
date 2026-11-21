import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../../db.ts';
import { projectInfoEmbed } from './board.ts';
import { isValidLinkUrl } from './links.ts';
import { projectsStore, type Project } from './store.ts';

function setup() {
  const store = projectsStore(openDatabase(mkdtempSync(join(tmpdir(), 'discord-kit-links-'))));
  const project = store.createProject({
    key: 'DK',
    name: 'discord-kit',
    template: 'dev',
    visibility: 'public',
    createdBy: 'u1',
    categoryId: 'c',
    forumId: 'f',
    boardId: 'b',
    activityId: 'a',
    roleId: 'r',
  });
  return { store, project };
}

test('accepts only http and https links', () => {
  assert.equal(isValidLinkUrl('https://figma.com/file/abc'), true);
  assert.equal(isValidLinkUrl('http://localhost:3000'), true);
  for (const bad of ['figma.com', 'ftp://x.y', 'javascript:alert(1)', 'https://', '']) {
    assert.equal(isValidLinkUrl(bad), false, bad);
  }
});

test('adds, lists in order and removes links', () => {
  const { store, project } = setup();
  assert.equal(store.addLink(project.id, 'Figma', 'https://figma.com/a'), 'added');
  assert.equal(store.addLink(project.id, 'Roadmap', 'https://trello.com/b'), 'added');
  assert.equal(store.addLink(project.id, 'figma', 'https://figma.com/other'), 'exists');
  assert.deepEqual(
    store.links(project.id).map((l) => l.name),
    ['Figma', 'Roadmap'],
  );
  assert.equal(store.removeLink(project.id, 'FIGMA'), true);
  assert.equal(store.removeLink(project.id, 'Figma'), false);
  assert.deepEqual(
    store.links(project.id).map((l) => l.name),
    ['Roadmap'],
  );
});

test('allows at most 25 links per project', () => {
  const { store, project } = setup();
  for (let i = 0; i < 25; i++) assert.equal(store.addLink(project.id, `L${i}`, 'https://x.y'), 'added');
  assert.equal(store.addLink(project.id, 'one more', 'https://x.y'), 'full');
});

test('the info message shows template, repos and links', () => {
  const project = { name: 'discord-kit', key: 'DK', template: 'dev' } as Project;
  const embed = projectInfoEmbed(
    project,
    [
      { owner: 'acme', name: 'web', isDefault: true },
      { owner: 'acme', name: 'api', isDefault: false },
    ],
    [{ name: 'Figma', url: 'https://figma.com/a' }],
  ).toJSON();
  const field = (name: string) => embed.fields?.find((f) => f.name === name)?.value;
  assert.equal(embed.title, 'ℹ️ discord-kit (DK)');
  assert.equal(field('Template'), 'dev');
  assert.equal(field('Repos'), 'acme/web (default)\nacme/api');
  assert.equal(field('Links'), '[Figma](https://figma.com/a)');
});

test('the info message says none and keeps fields within 1024 characters', () => {
  const project = { name: 'x', key: 'XX', template: 'simple' } as Project;
  const empty = projectInfoEmbed(project, [], []).toJSON();
  assert.equal(empty.fields?.find((f) => f.name === 'Repos')?.value, 'none');
  assert.equal(empty.fields?.find((f) => f.name === 'Links')?.value, 'none');
  const many = Array.from({ length: 25 }, (_, i) => ({
    name: `Link ${i}`,
    url: `https://example.com/${'p'.repeat(60)}/${i}`,
  }));
  const links =
    projectInfoEmbed(project, [], many)
      .toJSON()
      .fields?.find((f) => f.name === 'Links')?.value ?? '';
  assert.ok(links.length <= 1024);
  assert.ok(links.endsWith('…'));
});
