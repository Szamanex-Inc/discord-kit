import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { watchPreset } from './reload.ts';

test('calls back once for a burst of config.yaml changes and ignores other files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-kit-watch-'));
  writeFileSync(join(dir, 'config.yaml'), 'a');
  let calls = 0;
  const watcher = watchPreset(dir, () => calls++, 100);
  try {
    // Some platforms (macOS FSEvents) deliver the file creation above after the watch starts,
    // so let it settle and count only what happens afterwards.
    await sleep(500);
    calls = 0;
    writeFileSync(join(dir, 'other.md'), 'x');
    await sleep(250);
    assert.equal(calls, 0);
    writeFileSync(join(dir, 'config.yaml'), 'b');
    writeFileSync(join(dir, 'config.yaml'), 'c');
    await sleep(400);
    assert.equal(calls, 1);
  } finally {
    watcher.close();
  }
});
