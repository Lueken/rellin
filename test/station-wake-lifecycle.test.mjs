import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('wake catches up a running table before expired deadlines without restarting agents or replaying prompts', { timeout: 90000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/wake-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file], { windowsHide: true, timeout: 85000 });
  assert.match(stdout, /Wake lifecycle passed/);
});
