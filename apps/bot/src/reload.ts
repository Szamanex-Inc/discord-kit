import { watch, type FSWatcher } from 'node:fs';

/**
 * Calls `onChange` when config.yaml in the preset folder changes. The folder is watched instead of
 * the file because editors and `git pull` replace files, which breaks a watch on the file itself.
 * Bursts of events are collapsed into one call after `delayMs`.
 */
export function watchPreset(dir: string, onChange: () => void, delayMs = 1000): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dir, (_event, filename) => {
    if (filename !== 'config.yaml') return;
    clearTimeout(timer);
    timer = setTimeout(onChange, delayMs);
  });
  watcher.on('close', () => clearTimeout(timer));
  return watcher;
}
