import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import { loadHistory, prepareResume } from '../../station-history.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'station-codex-pty-'));
const fake = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), trace = path.join(root, 'trace.jsonl');
for (const agent of ['claude', 'codex']) await writeFile(path.join(root, process.platform === 'win32' ? `${agent}.cmd` : agent), process.platform === 'win32'
  ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
const env = { ...process.env, STATION_HOME: root, CODEX_HOME: root, CLAUDE_CONFIG_DIR: root, STATION_TEST_TRACE: trace, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = [root, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
const index = process.argv.includes('--second') ? 1 : 0;
const lineup = index ? 'claude,codex:default:high' : 'codex:default:high,claude';
const proc = pty.spawn(process.execPath, [path.resolve('station.mjs'), '--seats', lineup], { cwd: root, env, cols: 160, rows: 40, name: 'xterm-256color' });
let output = '', exited = false;
proc.onData(data => { output += data; });
proc.onExit(() => { exited = true; });
const until = async (check, description) => { for (let i = 0; i < 200 && !check() && !exited; i++) await delay(100); assert.ok(check(), `${description}: ${output.slice(-1500)}`); };
const active = () => {
  try { return loadHistory({ dir: root }).find(run => run.active); }
  catch (error) { if (/no such table: stations/.test(error.message)) return undefined; throw error; }
};
try {
  await until(() => active()?.seats.every(seat => seat.attention?.lifecycle === 'running') && output.includes(index ? 'CLAUDE READY' : 'CODEX READY'), 'both seats running, focused terminal visible');
  proc.write(`\x1b${index + 1}`); await delay(100);
  await until(() => output.includes('CODEX READY'), 'focused Codex terminal visible');
  if (index) {
    // Local startup commands/choices can precede creation of paginated history.
    // They must not latch a watchdog fault before the first actual request.
    proc.write('/model'); await delay(100); proc.write('\r');
    await until(() => output.includes('CODEX LOCAL MODEL MENU'), 'local model menu');
    proc.write('2'); await delay(100); proc.write('\r');
    await delay(31000);
    assert.notEqual(active().seats[index].attention.watcher.state, 'error', 'startup navigation did not poison native discovery');
    assert.equal(active().seats[index].attention.completionVersion, 0);
  }
  proc.write('\x1bh'); await until(() => output.includes('Fresh-chat handoff'), 'popup'); output = '';
  proc.write('\r'); await until(() => output.includes('Send a first message'), 'empty conversation explanation');
  proc.write('\x1b'); await delay(100); output = '';
  proc.write('begin\r'); await until(() => active()?.seats[index]?.attention.completionVersion === 1, 'first Codex answer tracked');
  const originalId = active().seats[index].nativeId;
  output = ''; proc.write('\x1bh'); await until(() => output.includes('Fresh-chat handoff'), 'second popup'); output = '';
  proc.write('\r'); await until(() => active()?.seats[index]?.handoff?.status === 'done' && active()?.seats[index]?.nativeId, 'fresh Codex continuation');
  assert.ok(!output.includes('Fresh-chat handoff'), 'Enter must dismiss the popup');
  assert.ok(output.includes('CODEX READY'), 'underlying agent pane is visible');
  const run = active(); assert.notEqual(run.seats[index].nativeId, originalId);
  assert.equal(run.seats[1 - index].agent, 'claude');
  assert.equal(run.seats[index].bypass, false);
  const original = loadHistory({ dir: root }).find(item => item.id === run.seats[index].handoffFrom.sourceArchiveId);
  assert.equal(original.seats[0].nativeId, originalId);
  // The archived source can be resumed despite never having a JSONL rollout.
  process.env.CODEX_HOME = root;
  assert.equal((await prepareResume(original))[0].boundary.storage, 'sqlite');
  const entries = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter(item => item.type === 'launch' && item.agent === 'codex').length, 2);
  assert.equal(entries.filter(item => item.type === 'launch' && item.agent === 'claude').length, 1);
  assert.equal(entries.filter(item => item.type === 'input' && item.agent === 'claude').length, 0);
  const prompts = entries.filter(item => item.type === 'input' && item.text.includes('Station handoff request'));
  assert.equal(prompts.length, 1);
  await until(() => active().seats[index].attention.completionVersion === 1, 'continuation answer tracked');
  const continuationId = active().seats[index].nativeId;
  output = ''; proc.write('\x1bs'); await until(() => output.includes('Manage seats'), 'Codex seat manager');
  proc.write('r'); await delay(150); output = ''; proc.write('\r');
  await until(() => output.includes('codex restarted'), 'Codex restart');
  assert.equal(active().seats[index].nativeId, continuationId);
  assert.equal(active().seats[index].attention.completionVersion, 1, 'SQLite boundary prevents replay');
  const afterRestart = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  const launches = afterRestart.filter(item => item.type === 'launch' && item.agent === 'codex');
  assert.equal(launches.length, 3); assert.equal(launches.at(-1).id, continuationId);
  assert.ok(launches.at(-1).args.includes('resume'));
  assert.equal(afterRestart.filter(item => item.type === 'launch' && item.agent === 'claude').length, 1);
  proc.write('\x11'); await until(() => exited, 'quit');
  console.log('Codex lifecycle passed');
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (!exited) proc.kill(); }
// ConPTY socket workers can outlive normal PTY exit in this isolated fixture.
process.exit(process.exitCode || 0);
