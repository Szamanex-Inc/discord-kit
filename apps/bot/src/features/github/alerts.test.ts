import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertsFor, ciStateOf, issueRefs, type PrFacts } from './alerts.ts';

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 7,
  title: 'Add sync',
  url: 'https://github.com/acme/web/pull/7',
  author: 'alice',
  headSha: 'aaa',
  ciState: 'pending',
  failingChecks: [],
  conflicts: false,
  changesRequestedBy: [],
  ...over,
});
const kinds = (r: ReturnType<typeof alertsFor>) => r.alerts.map((a) => a.kind);

test('alerts once per commit when CI fails', () => {
  const first = alertsFor(undefined, facts({ ciState: 'failure', failingChecks: ['test'] }));
  assert.deepEqual(kinds(first), ['ci-failed']);
  assert.match(first.alerts[0]!.text, /test/);
  const rerun = alertsFor(first.memory, facts({ ciState: 'failure', failingChecks: ['test'] }));
  assert.deepEqual(kinds(rerun), []);
  const newCommit = alertsFor(
    rerun.memory,
    facts({ headSha: 'bbb', ciState: 'failure', failingChecks: ['lint'] }),
  );
  assert.deepEqual(kinds(newCommit), ['ci-failed']);
});

test('says CI passes again only after a failure was alerted', () => {
  const green = alertsFor(undefined, facts({ ciState: 'success' }));
  assert.deepEqual(kinds(green), []);
  const failed = alertsFor(green.memory, facts({ ciState: 'failure', failingChecks: ['test'] }));
  const fixed = alertsFor(failed.memory, facts({ headSha: 'bbb', ciState: 'success' }));
  assert.deepEqual(kinds(fixed), ['ci-fixed']);
  assert.deepEqual(kinds(alertsFor(fixed.memory, facts({ headSha: 'bbb', ciState: 'success' }))), []);
});

test('alerts when merge conflicts appear, not while they stay', () => {
  const conflicted = alertsFor(alertsFor(undefined, facts()).memory, facts({ conflicts: true }));
  assert.deepEqual(kinds(conflicted), ['conflicts']);
  assert.deepEqual(kinds(alertsFor(conflicted.memory, facts({ conflicts: true }))), []);
});

test('alerts for each reviewer who newly requests changes', () => {
  const first = alertsFor(undefined, facts({ changesRequestedBy: ['bob'] }));
  assert.deepEqual(kinds(first), ['changes-requested']);
  assert.match(first.alerts[0]!.text, /bob/);
  const again = alertsFor(first.memory, facts({ changesRequestedBy: ['bob', 'carol'] }));
  assert.deepEqual(kinds(again), ['changes-requested']);
  assert.match(again.alerts[0]!.text, /carol/);
  assert.doesNotMatch(again.alerts[0]!.text, /bob/);
});

test('reads CI state from check runs and statuses', () => {
  assert.deepEqual(ciStateOf([{ name: 'test', status: 'completed', conclusion: 'success' }], []), {
    state: 'success',
    failing: [],
  });
  assert.deepEqual(
    ciStateOf(
      [
        { name: 'test', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'completed', conclusion: 'success' },
      ],
      [{ context: 'ci/deploy', state: 'error' }],
    ),
    { state: 'failure', failing: ['test', 'ci/deploy'] },
  );
  assert.equal(ciStateOf([{ name: 'test', status: 'in_progress', conclusion: null }], []).state, 'pending');
  assert.equal(ciStateOf([], []).state, 'pending');
  assert.equal(ciStateOf([{ name: 'x', status: 'completed', conclusion: 'skipped' }], []).state, 'success');
});

test('finds issue references to the same repo', () => {
  assert.deepEqual(issueRefs('Fixes #12 and closes acme/web#13', 'acme', 'web'), [12, 13]);
  assert.deepEqual(issueRefs('see other/repo#5 and #12 #12', 'acme', 'web'), [12]);
  assert.deepEqual(issueRefs('no refs here, PR-12', 'acme', 'web'), []);
});

test('a reviewer requests changes until their latest review says otherwise', async () => {
  const { requestingChanges } = await import('./alerts.ts');
  assert.deepEqual(
    requestingChanges([
      { user: 'bob', state: 'CHANGES_REQUESTED' },
      { user: 'carol', state: 'CHANGES_REQUESTED' },
      { user: 'carol', state: 'APPROVED' },
      { user: 'dave', state: 'CHANGES_REQUESTED' },
      { user: 'dave', state: 'COMMENTED' },
    ]),
    ['bob', 'dave'],
  );
});
