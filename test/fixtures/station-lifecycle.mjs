import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { loadHistory } from '../../station-history.mjs';
import { DatabaseSync } from 'node:sqlite';

// A real PTY and CLI entrypoint, but no provider account or model calls.
const children = new Set();
async function smoke() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-lifecycle-'));
  const fake = path.join(root, 'fake-agent.mjs');
  const trace = path.join(root, 'launches.jsonl');
  await writeFile(fake, `import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Fake Claude help'); process.exit(0); }
const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const folder = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(folder, { recursive: true });
fs.appendFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({type:'user',message:{content:'fixture'}}) + '\\n');
fs.appendFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({type:'assistant',message:{id:'reply-' + Date.now(),stop_reason:'end_turn',content:[{type:'text',text:'fixture response'}]}}) + '\\n');
fs.appendFileSync(process.env.STATION_TEST_TRACE, JSON.stringify({ id, args, cwd: process.cwd() }) + '\\n');
console.log('FAKE AGENT READY');
if (process.env.STATION_TEST_FAIL === '1') setTimeout(() => process.exit(7), 100);
process.stdin.resume();
let input = '';
process.stdin.on('data', data => {
  fs.appendFileSync(process.env.STATION_TEST_TRACE + '.input', data);
  if (!process.env.STATION_TEST_HANDOFF) return;
  input += data;
  if (!input.includes('\\r')) return;
  const text = input.replace(/\\x1b\\[200~|\\x1b\\[201~|\\r/g, ''); input = '';
  const match = /Station handoff request ([a-f0-9-]+)/.exec(text);
  if (!match) return;
  const reply = '# Handoff\\n' + ['Goal', 'Current state', 'Decisions', 'Files', 'Open problems', 'Next steps'].map(h => '## ' + h + '\\nDetails').join('\\n') + '\\n<!-- station-handoff:' + match[1] + ':end -->';
  fs.appendFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({type:'user',message:{content:text}}) + '\\n');
  fs.appendFileSync(path.join(folder, id + '.jsonl'), JSON.stringify({type:'assistant',message:{id:'summary-' + match[1],stop_reason:'end_turn',content:[{type:'text',text:reply}]}}) + '\\n');
  console.log('HANDOFF WRITTEN');
});
`);
  const launcher = path.join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  await writeFile(launcher, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, STATION_HOME: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, STATION_TEST_TRACE: trace, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
  // Windows environments can expose Path rather than PATH; do not keep both.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [root, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  const interactive = process.argv.includes('--interactive');
  const failure = process.argv.includes('--failure');
  const handoff = process.argv.includes('--handoff');
  const recordingCloseFailure = process.argv.includes('--recording-close-failure');
  const recordingFailure = process.argv.includes('--recording-failure') || recordingCloseFailure;
  if (handoff) env.STATION_TEST_HANDOFF = '1';
  if (failure) env.STATION_TEST_FAIL = '1';
  const deliverable = path.join(root, 'test report.md');
  if (interactive) await writeFile(deliverable, '# Report\nFixture');
  const run = async (args, resume = false) => {
    const proc = pty.spawn(process.execPath, [path.resolve('station.mjs'), ...args], { cwd: root, env, cols: 120, rows: 30, name: 'xterm-256color' });
    children.add(proc);
    const display = new headless.Terminal({cols:120,rows:30,allowProposedApi:true});
    let output = '', exited = false;
    let screenEntries=0,screenExits=0;
    proc.onData(data => {
      output += data;
      display.write(data);
      screenEntries += [...data.matchAll(/\x1b\[\?(?:1049|1047|47)h/g)].length;
      screenExits += [...data.matchAll(/\x1b\[\?(?:1049|1047|47)l/g)].length;
    });
    const exit = new Promise(resolve => proc.onExit(event => { exited = true; children.delete(proc); resolve(event); }));
    const waitFor = async text => {
      for (let i = 0; i < 150 && !output.includes(text) && !exited; i++) await delay(100);
      assert.ok(output.includes(text), `missing ${text}: ${output.slice(-2000)}`);
      output = '';
    };
    if (interactive) {
      await waitFor('Who works in this Rellin session?');
      // Fresh launches always show setup, even when resumable history exists.
      // At the default width, Continue sits above four vertical presets.
      if (!resume) {
        proc.write('\x1b[<0;3;23M\x1b[<0;3;23m'); await waitFor('Enter resumes');
        proc.write('\x1b'); await waitFor('Who works in this Rellin session?');
      }
      proc.write('c'); await waitFor('Enter resumes');
      if (!resume) {
        proc.write('p'); await waitFor('Projects'); proc.write('p'); await waitFor('Project pinned.');
        proc.write('\r'); await waitFor('Enter resumes');
      }
      if (resume) {
        proc.write('v'); await waitFor('fixture response');
        proc.write('q'); await waitFor('Enter resumes');
      }
      if (!resume) {
        proc.write('n'); await waitFor('Session name:');
        proc.write('Lifecycle test'); await waitFor('Lifecycle test');
        proc.write('\r'); await waitFor('Who works in this Rellin session?');
        proc.write('\x1b[<0;26;2M\x1b[<32;40;2M\x1b[<0;40;2m');
        await waitFor('Click a field');
        // At 120x30 with a 40-column shelf all four preset buttons share
        // the last shelf row. Click Solo, then exercise a dropdown.
        proc.write('\x1b[<0;3;29M\x1b[<0;3;29m'); await waitFor('New session');
        proc.write('\x1b[<0;9;4M\x1b[<0;9;4m'); await waitFor('sonnet');
        proc.write('\x1b'); await waitFor('Click a field');
        proc.write('\x1b[<0;43;16M\x1b[<0;43;16m');
      } else {
        proc.write('\r');
      }
    }
    await waitFor('FAKE AGENT READY');
    assert.equal(screenEntries,1,'Rellin owns one alternate screen across setup, history and launch');
    assert.equal(screenExits,0,'transitions never expose the original shell');
    let tracked;
    for (let i = 0; i < 100; i++) {
      tracked = loadHistory({ dir: root })[0]?.seats[0]?.attention;
      if (tracked?.completionVersion >= (resume ? 2 : 1) && (!failure || tracked.lifecycle === 'failed')) break;
      await delay(50);
    }
    assert.equal(tracked?.completionVersion, resume ? 2 : 1);
    assert.equal(tracked?.unread, true);
    if (recordingFailure) {
      const db = new DatabaseSync(path.join(root, 'station.db'));
      try {
        db.exec("CREATE TRIGGER reject_wait BEFORE INSERT ON events WHEN NEW.type = 'table-turn-wait' BEGIN SELECT RAISE(ABORT, 'fixture recording failure'); END");
        proc.write('\x1b`'); await waitFor('type a topic');
        proc.write('\x1b='); await waitFor('Record incomplete');
        await delay(200);
        assert.match(display.buffer.active.getLine(29).translateToString(), /Record incomplete/);
        db.exec('DROP TRIGGER reject_wait');
        proc.write('\x1b='); await waitFor('writes recovered');
        proc.write('\x1b`'); await waitFor('Record incomplete');
        await delay(200);
        assert.match(display.buffer.active.getLine(29).translateToString(), /Record incomplete.*writes recovered/);
        assert.equal(exited, false, 'recording failure leaves the live agent running');
      } finally { db.close(); }
    }
    if(interactive) {
      await delay(100);
      assert.equal(display.buffer.active.getLine(0).getCell(39).getChars(),'│','saved 40-column shelf is restored in the next process');
      assert.equal(tracked.readVersion,resume?1:0,'explicit read version survives process restart');
      proc.write('\x1bu');await waitFor(resume?'Cache reminders on':'Cache reminders off');
      if(!resume) {proc.write('r');await waitFor('Cache reminders on');}
      proc.write('\x1b');await waitFor('FAKE AGENT READY');
    }
    if (failure) {
      assert.equal(tracked.lifecycle, 'failed');
      assert.equal(tracked.exitCode, 7);
    }
    if (handoff) {
      for (let round = 0; round < 2; round++) {
        proc.write('\x1bh'); await waitFor('Fresh-chat handoff');
        proc.write('\r'); await waitFor('Handoff: done');
        for (let i = 0; i < 100; i++) {
          const current = loadHistory({ dir: root }).find(run => run.active);
          if (current?.seats[0].attention?.completionVersion >= 1) break;
          await delay(50);
        }
      }
    }
    if (interactive) {
      proc.write('\x1bo'); await waitFor('No local file references');
      proc.write('s'); await waitFor('File opening settings');
      proc.write('\r'); await waitFor('Settings saved.');
      proc.write('\x1b'); await waitFor('No local file references');
      proc.write('p'); await waitFor('File path:');
      proc.write(deliverable); await waitFor('test report.md_');
      proc.write('\r'); await waitFor('Enter opens this file.');
      proc.write('\x1b'); await waitFor('FAKE AGENT READY');
      proc.write('\x1bt'); await waitFor('fixture response');
      proc.write('f'); await waitFor('No local file references');
      proc.write('\x1b'); await waitFor('fixture response');
      proc.write('/'); await waitFor('Search:');
      proc.write('response'); await waitFor('response_');
      proc.write('\r'); await waitFor('Filter: response');
      proc.write('c'); await waitFor('Copy requested');
      if(!resume) {
        proc.write('m');
        for(let i=0;i<50 && loadHistory({dir:root})[0].seats[0].attention.readVersion!==1;i++)await delay(50);
        assert.equal(loadHistory({dir:root})[0].seats[0].attention.readVersion,1,'explicitly acknowledge v1 before quitting');
      }
      proc.write('q'); await waitFor('FAKE AGENT READY');
    }
    let closingLock;
    if (recordingCloseFailure) {
      closingLock = new DatabaseSync(path.join(root, 'station.db'));
      closingLock.exec('BEGIN IMMEDIATE');
    }
    proc.write('\x11');
    let timer;
    try {
      const result = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Rellin did not quit')), 5000); })]);
      assert.equal(result.exitCode, recordingCloseFailure ? 1 : 0);
      assert.equal(screenExits,1,'quit restores the original shell once');
      if (recordingFailure) assert.match(output, /Ledger: /, 'recording warning is printed after leaving the alternate screen');
      if (recordingCloseFailure) assert.match(output, /Rellin could not finish saving/);
    } finally {
      if (closingLock) { closingLock.exec('ROLLBACK'); closingLock.close(); }
      clearTimeout(timer); display.dispose();
    }
  };
  await run(interactive ? [] : ['--seats', 'claude:opus:high', '--name', 'Lifecycle test']);
  if (handoff) {
    const runs = loadHistory({ dir: root });
    assert.equal(runs.length, 3);
    const continued = runs.find(run => !run.seats[0].handoffTo);
    const original = runs.find(run => run.id === continued.seats[0].handoffFrom.sourceArchiveId);
    assert.ok(original && continued);
    assert.notEqual(original.seats[0].nativeId, continued.seats[0].nativeId);
    assert.equal(continued.seats[0].handoffFrom.sourceArchiveId, original.id);
    assert.equal(original.seats[0].handoffTo.destinationStationId, continued.id);
    const launches = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(launches.length, 3);
    assert.equal(new Set(launches.map(launch => launch.id)).size, 3);
    assert.ok(!launches[1].args.includes('--resume'));
    assert.ok(launches[1].args.includes('--add-dir'));
    assert.equal(launches[1].args[launches[1].args.indexOf('--model') + 1], 'opus');
    assert.equal(launches[1].args[launches[1].args.indexOf('--effort') + 1], 'high');
    assert.ok(!launches[1].args.includes('--dangerously-skip-permissions'));
    const file = continued.seats[0].handoff.file;
    assert.match(await readFile(file, 'utf8'), /^# Handoff/);
    assert.ok(launches[2].args[0].includes(file));
    assert.equal(path.dirname(file), path.join(root, 'handoffs'));
    assert.equal(continued.seats[0].handoff.status, 'done');
    return;
  }
  const first = loadHistory({ dir: root })[0];
  assert.equal(first.name, 'Lifecycle test');
  assert.equal(first.active, false);
  assert.ok(first.seats[0].nativeId);
  assert.equal(first.seats[0].attention.unread, !interactive);
  if (recordingFailure) {
    assert.equal(first.recordingIssues.length, 1);
    assert.equal(first.recordingIssues[0].gaps.ledger.lastEvent, 'table-turn-wait');
    return;
  }
  if(interactive) assert.deepEqual(JSON.parse(await readFile(path.join(root,'station-ui.json'),'utf8')),{shelfWidth:40,cacheReminders:true});
  if (failure) { assert.equal(first.seats[0].attention.lifecycle, 'failed'); return; }
  assert.equal(first.seats[0].attention.lifecycle, 'stopped');
  await run(interactive ? [] : ['--resume', first.id], true);
  if (interactive) assert.deepEqual(JSON.parse(await readFile(path.join(root, 'station-projects.json'), 'utf8')).pinned, [root]);
  const launches = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(launches.length, 2);
  assert.equal(launches[1].id, launches[0].id);
  assert.ok(launches[1].args.includes('--resume'));
  assert.ok(!launches[1].args.includes('--session-id'));
  assert.ok(!launches[1].args.includes('--dangerously-skip-permissions'));
  assert.equal(launches[1].cwd, launches[0].cwd);
  const history = loadHistory({ dir: root });
  assert.equal(history.length, 2);
  assert.equal(history[0].resumed_from, first.id);
  assert.equal(history[0].seats[0].attention.completionVersion, 2);
  assert.equal(history[0].seats[0].attention.readVersion, interactive?1:0, 'reading a view does not implicitly acknowledge the new answer');
  assert.equal(await readFile(trace + '.input', 'utf8').catch(() => ''), '', 'viewer keys never reach the agent');
}

// Isolate ConPTY socket workers that can outlive normal PTY exit.
smoke().then(() => { console.log('Lifecycle passed'); process.exit(0); }, error => {
  for (const child of children) { try { child.kill(); } catch { } }
  console.error(error);
  process.exit(1);
});
