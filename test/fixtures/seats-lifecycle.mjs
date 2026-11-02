import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, appendFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { main } from '../../station.mjs';
import { loadHistory } from '../../station-history.mjs';

const self = fileURLToPath(import.meta.url);
if (process.argv.includes('--agent')) {
  if (process.argv.includes('--help')) { console.log("--model 'opus' --effort (high, max)"); process.exit(0); }
  const args = process.argv.slice(3), root = process.env.STATION_HOME;
  const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
  const defaults = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  const effectiveMode = args.includes('--dangerously-skip-permissions') ? 'bypassPermissions'
    : args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : defaults.permissions.defaultMode;
  await appendFile(path.join(root, 'launches.jsonl'), JSON.stringify({ id, args, effectiveMode, pid: process.pid }) + '\n');
  if (await readFile(path.join(root, 'fail'), 'utf8').catch(() => '')) process.exit(7);
  const folder = path.join(root, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, id + '.jsonl');
  const answer = text => appendFile(file, JSON.stringify({ type: 'assistant', message: { id: text, stop_reason: 'end_turn', content: [{ type: 'text', text }] } }) + '\n');
  if (!args.includes('--resume')) await answer('initial');
  process.stdout.write('AGENT READY\r\n');
  process.stdin.setRawMode?.(true); process.stdin.resume();
  process.stdin.on('data', data => { void appendFile(path.join(root, `input-${id}.txt`), data); if (String(data).includes('ping')) { void answer('pong'); process.stdout.write('SURVIVOR PONG\r\n'); } });
} else if (process.argv.includes('--station')) {
  const resume = process.argv.includes('--resume-run');
  await main(resume ? ['--resume', process.argv.at(-1)] : ['--seats', 'claude:opus:high:auto,claude', '--name', 'Seat test']);
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-seat-lifecycle-'));
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  await writeFile(path.join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${self}" --agent %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${self}" --agent "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, STATION_HOME: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [root, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  let proc, display, output = '', exited = false;
  const launch = args => {
    output = ''; exited = false;
    display = new headless.Terminal({ cols: 150, rows: 35, allowProposedApi: true });
    proc = pty.spawn(process.execPath, [self, '--station', ...args], { cwd: root, env, cols: 150, rows: 35 });
    proc.onData(data => { output += data; display.write(data); }); proc.onExit(() => { exited = true; });
  };
  const contents = file => readFile(path.join(root, file), 'utf8').catch(() => '');
  const launches = async () => (await contents('launches.jsonl')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const screen = () => Array.from({ length: display.rows }, (_, row) => display.buffer.active.getLine(display.buffer.active.viewportY + row)?.translateToString(true) || '').join('\n');
  const until = async (predicate, name) => { for (let i = 0; i < 160 && !await predicate() && !exited; i++) await delay(100); assert.ok(await predicate(), `${name}: ${output.slice(-1800)}\nRoot: ${root}`); };
  const key = async text => { proc.write(text); await delay(130); };
  const menu = async () => { await key('\x1bs'); await until(() => screen().includes('Manage seats'), 'seat popup'); };
  const confirm = async command => { await key(command); await key('\r'); };
  const active = () => loadHistory({ dir: root }).find(run => run.active);
  try {
    launch([]);
    await until(async () => (await launches()).length === 2 && screen().includes('AGENT READY'), 'initial agents');
    const original = active(), ids = original.seats.map(seat => seat.nativeId);
    assert.equal((await launches()).find(item => item.id === ids[0]).effectiveMode, 'bypassPermissions', 'explicit auto is honored');
    assert.equal((await launches()).find(item => item.id === ids[1]).effectiveMode, 'manual', 'manual overrides provider default');
    await until(() => active().seats.every(seat => seat.attention?.completionVersion === 1), 'initial tracking');
    await menu(); await confirm('x');
    await until(() => active().seats.length === 1 && !screen().includes('Manage seats'), 'close first seat dismisses popup');
    assert.equal(active().seats[0].nativeId, ids[1]); assert.equal(active().seats[0].seat, 'claude-2');
    assert.equal(loadHistory({ dir: root }).find(run => run.id !== original.id).seats[0].nativeId, ids[0]);
    await key('ping');
    await until(() => active().seats[0].attention.completionVersion === 2 && screen().includes('SURVIVOR PONG'), 'survivor output and watcher follow new index');
    assert.equal(await contents(`input-${ids[0]}.txt`), '');
    assert.equal(await contents(`input-${ids[1]}.txt`), 'ping');
    await menu(); await confirm('x'); await until(() => screen().includes('Keep one seat'), 'last seat cannot close'); await key('\x1b');
    await writeFile(path.join(root, 'fail'), 'yes');
    await menu(); await key('a'); await until(() => screen().includes('Add an agent'), 'add form'); await key('\r');
    await until(() => screen().includes('No seat was added.'), 'failed add'); assert.equal(active().seats.length, 1);
    await unlink(path.join(root, 'fail'));
    // User regression: select Claude / Opus / high, leave mode untouched.
    await key('\t'); await key('\x1b[C'); await key('\t'); await key('\x1b[C'); await key('\r');
    await until(() => active().seats.length === 2 && !screen().includes('Manage seats'), 'add succeeds');
    const added = active().seats[1];
    assert.equal(added.seat, 'claude'); assert.equal(added.model, 'opus'); assert.equal(added.effort, 'high'); assert.equal(added.bypass, false);
    assert.equal((await launches()).find(item => item.id === added.nativeId).effectiveMode, 'manual');
    assert.equal((await launches()).filter(item => item.id === ids[1]).length, 1, 'survivor never relaunched');
    await until(() => active().seats[1].attention?.completionVersion === 1, 'new seat tracked');
    // Keep both existing colors occupied: the old add path referenced a
    // removed ALT_COLORS constant only when the primary was already taken.
    await menu(); await key('a'); await until(() => screen().includes('Add an agent'), 'duplicate add form'); await key('\r');
    await until(() => active().seats.length === 3 && !screen().includes('Manage seats'), 'duplicate provider added with primary color occupied');
    // The ledger can commit before the PTY/headless renderer paints the new
    // lineup. Wait for rendered evidence, not merely for the popup to disappear.
    await until(()=>new Set([2,8,14].map(row=>display.buffer.active.getLine(row).getCell(1).getFgColor())).size===3,'all live seats render distinct accents');
    await menu(); await confirm('x');
    await until(() => active().seats.length === 2 && !screen().includes('Manage seats'), 'remove temporary third seat');
    await menu(); await confirm('r');
    await until(async () => (await launches()).filter(item => item.id === added.nativeId).length === 2 && !screen().includes('Manage seats'), 'restart same conversation');
    const restarted = (await launches()).filter(item => item.id === added.nativeId).at(-1);
    assert.ok(restarted.args.includes('--resume')); assert.equal(restarted.effectiveMode, 'manual');
    assert.equal(active().seats[1].attention.completionVersion, 1, 'restart does not replay previous answer');
    await writeFile(path.join(root, 'fail'), 'yes');
    await menu(); await confirm('r'); await until(() => screen().includes('The seat is stopped'), 'failed restart keeps history');
    assert.equal(active().seats[1].nativeId, added.nativeId); assert.equal(active().seats[1].attention.lifecycle, 'stopped');
    await unlink(path.join(root, 'fail')); await confirm('r');
    await until(() => !screen().includes('Manage seats') && active().seats[1].attention.lifecycle === 'running', 'restart retry');
    assert.equal((await launches()).filter(item => item.id === ids[1]).length, 1);
    await key('\x11'); await until(() => exited, 'quit'); display.dispose();
    launch(['--resume-run', original.id]);
    await until(() => screen().includes('AGENT READY') && active()?.seats[0].seat === 'claude-2', 'changed lineup resumes with stable labels');
    assert.deepEqual(active().seats.map(seat => seat.nativeId), [ids[1], added.nativeId]);
    await key('\x11'); await until(() => exited, 'quit resumed');
    console.log('Seats lifecycle passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (!exited) proc?.kill(); display?.dispose(); }
  process.exit(process.exitCode || 0);
}
