import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

for (const locked of [false, true]) test(`recording warnings survive table, Console, history and ${locked ? 'locked' : 'normal'} shutdown`, { timeout: 45000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/station-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file, locked ? '--recording-close-failure' : '--recording-failure'], { windowsHide: true, timeout: 40000 });
  assert.match(stdout, /Lifecycle passed/);
});
