import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, unlinkSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import { main } from '../../station.mjs';
import { loadHistory } from '../../station-history.mjs';
import { readLedger } from '../../station-ledger.mjs';

const self = fileURLToPath(import.meta.url);
if (process.argv.includes('--station')) {
  // Simulate a suspended scheduler without sleeping the owner's computer.
  // Native fake agents keep writing, while Rellin's poll callbacks pause.
  const realNow = Date.now, interval = global.setInterval, timeout = global.setTimeout, cancel = global.clearTimeout;
  let shift = 0, suspended = false, tick;
  const due = new Map(), root = process.env.STATION_HOME;
  Date.now = () => realNow() + shift;
  global.setInterval = (fn, ms, ...args) => {
    if (ms === 1000) tick = () => fn(...args);
    return interval(() => { if (!suspended) fn(...args); }, ms);
  };
  global.setTimeout = (fn, ms, ...args) => {
    const timer = timeout(() => { due.delete(timer); fn(...args); }, ms);
    if (ms >= 30000) due.set(timer, () => fn(...args));
    return timer;
  };
  global.clearTimeout = timer => { due.delete(timer); cancel(timer); };
  interval(() => {
    const file = path.join(root, 'sleep-control');
    if (!existsSync(file)) return;
    const command = readFileSync(file, 'utf8'); if (!command) return;
    unlinkSync(file);
    if (command === 'sleep') suspended = true;
    if (command === 'wake') {
      shift += 8 * 60 * 60_000; suspended = false;
      // Worst ordering: health check and expired deadlines precede native polls.
      tick();
      for (const [timer, callback] of [...due]) { global.clearTimeout(timer); callback(); }
    }
    appendFileSync(path.join(root, 'wake-trace.jsonl'), JSON.stringify({ command }) + '\n');
  }, 25);
  await main(['--seats', 'claude,claude', '--name', 'Wake recovery']);
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-wake-pty-'));
  const fake = fileURLToPath(new URL('./table-lifecycle.mjs', import.meta.url));
  await writeFile(path.join(root, 'mode'), 'hold');
  await writeFile(path.join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fake}" --agent %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fake}" --agent "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, STATION_HOME: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [root, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  const proc = pty.spawn(process.execPath, [self, '--station'], { cwd: root, env, cols: 160, rows: 40 });
  let exited = false, output = '', runId;
  proc.onData(data => output = (output + data).slice(-3000)); proc.onExit(() => exited = true);
  const run = () => {
    try { return loadHistory({ dir: root }).find(r => r.active); }
    catch (error) { if (!runId && /no such table: stations/.test(error.message)) return; throw error; }
  };
  const lines = async file => (await readFile(path.join(root, file), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const events = () => { const reader = readLedger(path.join(root, 'station.db')); try { return reader.events(runId); } finally { reader.close(); } };
  const until = async (check, label) => {
    for (let i = 0; i < 300 && !await check() && !exited; i++) await delay(100);
    assert.ok(await check(), `${label}\n${root}\n${output}`);
  };
  const submissions = async () => (await lines('trace.jsonl')).filter(e => e.type === 'submit' && e.prompt.includes('Station table request'));
  try {
    await until(() => run()?.seats.length === 2 && run().seats.every(s => s.attention?.watcher.state === 'healthy'), 'initial native tracking');
    runId = run().id; const ids = run().seats.map(s => s.nativeId);
    proc.write('\x1b`'); await delay(150); proc.write('Wake recovery test'); await delay(150); proc.write('\r');
    await until(async () => (await submissions()).length === 2 && run().seats.every(s => s.attention.activity === 'working' && s.attention.source === 'native'), 'native opening requests');
    await writeFile(path.join(root, 'sleep-control'), 'sleep');
    await until(async () => (await lines('wake-trace.jsonl')).some(e => e.command === 'sleep'), 'Rellin polling paused');
    const finished = new Set((await submissions()).map(e => e.prompt));
    for (const id of ids) await writeFile(path.join(root, `control-${id}`), 'finish');
    await until(async () => (await lines('trace.jsonl')).filter(e => e.type === 'control' && e.command === 'finish').length === 2, 'answers written during suspension');
    assert.ok(run().seats.every(s => s.attention.completionVersion === 1), 'unobserved answers are not yet counted');
    await writeFile(path.join(root, 'sleep-control'), 'wake');
    await until(() => events().filter(e => e.type === 'table-response-match').length >= 2, 'wake deadlines collect exact answers');
    await until(async () => {
      for (const entry of await submissions()) if (!finished.has(entry.prompt)) {
        finished.add(entry.prompt); await writeFile(path.join(root, `control-${entry.id}`), 'finish');
      }
      return events().some(e => e.type === 'table-ended' && e.payload.reason === 'completed');
    }, 'same table completes after wake');
    assert.equal((await submissions()).length, 6, 'no replayed prompts');
    assert.equal(new Set((await submissions()).map(e => e.prompt)).size, 6);
    assert.equal(events().filter(e => e.type === 'table-response-match').length, 6);
    assert.equal(events().filter(e => ['table-timeout', 'table-blocked'].includes(e.type)).length, 0);
    assert.ok(JSON.stringify(events()).includes('Rechecking native history after a polling gap'));
    assert.deepEqual(run().seats.map(s => s.nativeId), ids);
    assert.equal((await lines('trace.jsonl')).filter(e => e.type === 'launch').length, 2, 'no agent restart');
    assert.ok(run().seats.every(s => s.attention.watcher.state === 'healthy' && s.attention.completionVersion === 4 && s.attention.readVersion === 0));
    proc.write('\x11'); await until(() => exited, 'quit');
    console.log('Wake lifecycle passed: same processes, six matched answers, no replay or false timeout.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (!exited) proc.kill(); }
  process.exit(process.exitCode || 0);
}
