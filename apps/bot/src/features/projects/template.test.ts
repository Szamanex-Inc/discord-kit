import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeatureContext } from '../../feature.ts';
import type { Project } from './store.ts';
import { projectTemplate, resetTemplateWarnings } from './tickets.ts';

function fakeCtx() {
  const warnings: string[] = [];
  const ctx = {
    preset: { config: { features: { projects: { enabled: true } } } },
    log: { warn: (_scope: string, message: string) => void warnings.push(message), info() {}, error() {} },
  } as unknown as FeatureContext;
  return { ctx, warnings };
}

const project = { id: 1, key: 'DK', template: 'gone' } as Project;

test('warns once per project when its template is missing', () => {
  resetTemplateWarnings();
  const { ctx, warnings } = fakeCtx();
  const first = projectTemplate(ctx, project);
  projectTemplate(ctx, project);
  projectTemplate(ctx, project);
  assert.equal(first[0]?.key, 'todo');
  assert.equal(warnings.length, 1);
});

test('warns again after a restart', () => {
  resetTemplateWarnings();
  const { ctx, warnings } = fakeCtx();
  projectTemplate(ctx, project);
  resetTemplateWarnings();
  projectTemplate(ctx, project);
  assert.equal(warnings.length, 2);
});
