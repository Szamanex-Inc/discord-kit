import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TEMPLATES,
  effectiveTemplates,
  ProjectsSchema,
  TemplateSchema,
  type StatusSpec,
} from './index.ts';

const status = (key: string, extra: Partial<StatusSpec> = {}): StatusSpec => ({ key, label: key, ...extra });

function assertRejects(template: unknown, pattern: RegExp) {
  const result = TemplateSchema.safeParse(template);
  assert.equal(result.success, false);
  const messages = result.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  assert.match(messages, pattern);
}

test('accepts the default templates', () => {
  TemplateSchema.parse(DEFAULT_TEMPLATES.dev);
  TemplateSchema.parse(DEFAULT_TEMPLATES.simple);
  assert.deepEqual(
    DEFAULT_TEMPLATES.dev!.map((s) => s.key),
    ['todo', 'in_progress', 'testing', 'blocked', 'ready', 'deployed'],
  );
  assert.deepEqual(
    DEFAULT_TEMPLATES.simple!.map((s) => s.key),
    ['todo', 'doing', 'done'],
  );
});

test('rejects a label longer than 20 characters', () => {
  const result = TemplateSchema.safeParse([{ key: 'ready', label: 'Ready for production!' }]);
  assert.equal(result.success, false);
  assert.ok(result.error!.issues.some((i) => i.path.includes('label')));
});

test('rejects duplicate keys', () => {
  assertRejects([status('todo'), status('todo', { label: 'Other' })], /duplicate key 'todo'/);
});

test('rejects duplicate labels ignoring case', () => {
  assertRejects([status('a', { label: 'Todo' }), status('b', { label: 'todo' })], /duplicate label 'todo'/);
});

test('rejects two blocked statuses', () => {
  assertRejects(
    [status('todo'), status('b1', { blocked: true }), status('b2', { blocked: true })],
    /one blocked/,
  );
});

test('rejects a status that is done and blocked', () => {
  assertRejects([status('todo'), status('x', { done: true, blocked: true })], /both done and blocked/);
});

test('rejects a first status that is done', () => {
  assertRejects([status('done', { done: true }), status('todo')], /first status/);
});

test('rejects more than 20 statuses', () => {
  assertRejects(
    Array.from({ length: 21 }, (_, i) => status(`s${i}`)),
    /20/,
  );
});

test('rejects an uppercase key', () => {
  assertRejects([status('InProgress')], /key/);
});

test('effectiveTemplates uses defaults when templates are omitted', () => {
  assert.deepEqual(Object.keys(effectiveTemplates(undefined)), ['dev', 'simple']);
  assert.deepEqual(Object.keys(effectiveTemplates({})), ['dev', 'simple']);
});

test('custom templates replace the defaults', () => {
  const cfg = ProjectsSchema.parse({ default_template: 'kanban', templates: { kanban: [status('todo')] } });
  assert.deepEqual(Object.keys(effectiveTemplates(cfg)), ['kanban']);
});

test('rejects a default_template that does not exist', () => {
  assert.equal(ProjectsSchema.safeParse({ default_template: 'nope' }).success, false);
  const noDefault = ProjectsSchema.safeParse({ templates: { kanban: [status('todo')] } });
  assert.equal(noDefault.success, false);
  assert.match(noDefault.error!.issues.map((i) => i.message).join('\n'), /default_template/);
});

test('rejects a role_format without {name}', () => {
  assert.equal(ProjectsSchema.safeParse({ role_format: 'Project' }).success, false);
  assert.equal(ProjectsSchema.safeParse({ role_format: 'Team {name}' }).success, true);
});
