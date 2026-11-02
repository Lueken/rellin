import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('four blank Claude/Codex seats finish a table with delayed native evidence and large peer context', { timeout: 200000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/table-bootstrap-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file], { windowsHide: true, timeout: 195000 });
  assert.match(stdout, /Blank four-seat table passed/);
});

test('table gates busy seats, cancels Enter at approval menus, correlates replies and stops on watcher failure', { timeout: 90000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/table-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file], { windowsHide: true, timeout: 85000 });
  assert.match(stdout, /Table safeguards lifecycle passed/);
});

test('seat manager closes, adds, restarts, recovers failures and resumes the changed lineup', { timeout: 90000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/seats-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file], { windowsHide: true, timeout: 85000 });
  assert.match(stdout, /Seats lifecycle passed/);
});

test('a solo Rellin launch quits and resumes the same native conversation', { timeout: 45000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/station-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file], { windowsHide: true, timeout: 40000 });
  assert.match(stdout, /Lifecycle passed/);
});

test('keyboard picker pins a project, names a solo session, then resumes it from history', { timeout: 60000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/station-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file, '--interactive'], { windowsHide: true, timeout: 55000 });
  assert.match(stdout, /Lifecycle passed/);
});

test('an agent exiting immediately after its final answer retains unread completion and failure status', { timeout: 45000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/station-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file, '--failure'], { windowsHide: true, timeout: 40000 });
  assert.match(stdout, /Lifecycle passed/);
});

test('fresh-chat handoff archives the original and opens a new native session with the same settings', { timeout: 60000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/station-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file, '--handoff'], { windowsHide: true, timeout: 55000 });
  assert.match(stdout, /Lifecycle passed/);
});

for (const second of [false, true]) test(`Codex handoff in seat ${second ? 2 : 1}: empty chat, popup dismissal, SQLite tracking and continuation`, { timeout: 90000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/codex-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file, ...(second ? ['--second'] : [])], { windowsHide: true, timeout: 85000 });
  assert.match(stdout, /Codex lifecycle passed/);
});

test('file picker handles failed open, route settings, and browser dispatch without opening real apps', { timeout: 45000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/files-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file], { windowsHide: true, timeout: 40000 });
  assert.match(stdout, /Files lifecycle passed/);
});

test('Ctrl-click and screenshot paste preserve draft, focus and composer ownership in a real PTY', { timeout: 60000 }, async () => {
  const file = fileURLToPath(new URL('./fixtures/interaction-lifecycle.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [file], { windowsHide: true, timeout: 55000 });
  assert.match(stdout, /Interaction lifecycle passed/);
});
