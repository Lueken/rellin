import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, appendFile, unlink } from 'node:fs/promises';
import { appendFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { main } from '../../station.mjs';
import { loadHistory } from '../../station-history.mjs';
import { readLedger } from '../../station-ledger.mjs';
import { displayWidth } from '../../station-markdown.mjs';

const self = fileURLToPath(import.meta.url);
if (process.argv.includes('--agent')) {
  if (process.argv.includes('--help')) { console.log('Fake Claude help'); process.exit(0); }
  const root = process.env.STATION_HOME, id = process.argv[process.argv.indexOf('--session-id') + 1];
  const folder = path.join(root, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${id}.jsonl`), control = path.join(root, `control-${id}`), trace = path.join(root, 'trace.jsonl');
  const record = item => appendFileSync(file, JSON.stringify(item) + '\n');
  const user = text => record({ type: 'user', uuid: randomUUID(), message: { content: text } });
  const answer = (text, sidechain = false) => record({ type: 'assistant', isSidechain: sidechain, message: { id: randomUUID(), stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
  const log = item => appendFileSync(trace, JSON.stringify({ id, ...item }) + '\n');
  log({type:'launch',pid:process.pid});
  const ready = (draft = '') => process.stdout.write(`\x1b[2J\x1b[HAGENT READY\r\n────────────────────────────\r\n❯ ${draft}\r\n────────────────────────────\x1b[3;${3 + draft.length}H`);
  let input = '', menu = false, localMenu = null;
  const settings = () => process.stdout.write(`\x1b[2J\x1b[H${localMenu === 'config-child' ? 'Theme choices' : 'Settings'}\r\nEsc to ${localMenu === 'config-child' ? 'go back' : 'close'}\r\n`);
  record({ type: 'mode', mode: 'normal', sessionId: id });
  record({ type: 'permission-mode', permissionMode: 'default', sessionId: id });
  user('initial');
  record({ type: 'attachment', attachment: { type: 'context', content: 'fixture metadata' } });
  record({ type: 'ai-title', aiTitle: 'Table safeguards', sessionId: id });
  answer('Ready'); ready();
  setInterval(() => {
    if (!existsSync(control)) return;
    const command = readFileSync(control, 'utf8');
    if (!command) return; // The async fixture writer may have just created it.
    unlinkSync(control);
    if (command === 'busy') user('outside work still running');
    if (command === 'finish') answer('outside work done');
    if (command === 'corrupt') appendFileSync(file, '{broken native record}\n');
    log({ type: 'control', command });
  }, 50);
  process.stdin.setRawMode?.(true); process.stdin.resume();
  process.stdin.on('data', raw => {
    const data = String(raw);
    log({ type: 'input', data });
    if (data === '\x1b') {
      input = '';
      if (localMenu === 'config-child') { localMenu = 'config'; settings(); return; }
      localMenu = null; menu = false; ready(); return;
    }
    if (data === '\x1b[A' && !menu && !localMenu) { input = '/config'; ready(input); return; }
    if (localMenu && data === '\r') { log({ type: 'local-menu-enter' }); localMenu = 'config-child'; settings(); return; }
    if (data.includes('\x03')) { input = ''; menu = false; user('[Request interrupted by user]'); ready(); return; }
    if (data.includes('\x1b[200~')) {
      log({ type: 'paste' });
      if (readFileSync(path.join(root, 'mode'), 'utf8') === 'menu') {
        menu = true; process.stdout.write('\x1b[2J\x1b[HAllow this operation?\r\n> 1. Yes\r\n  2. No\r\n');
      }
    }
    input += data.replace(/\x1b\[200~|\x1b\[201~/g, '');
    if (!data.includes('\r')) return;
    if (menu) { log({ type: 'MENU ENTER' }); return; }
    const prompt = input.replace(/\r/g, ''); input = '';
    log({ type: 'submit', prompt });
    if (prompt === '/usage') { localMenu = 'usage'; process.stdout.write('\x1b[2J\x1b[HUsage details\r\nEsc to close\r\n'); return; }
    if (prompt === '/config') { localMenu = 'config'; settings(); return; }
    if (!prompt.includes('Station table request')) { user(prompt); answer('Normal answer'); return; }
    if (readFileSync(path.join(root, 'mode'), 'utf8') === 'hold') { user(prompt); return; }
    // Deliberately make both version-baseline and latest-text attribution wrong.
    answer('UNRELATED EARLY COMPLETION'); user(prompt); answer('SIDECHAIN ANSWER', true);
    record({ type: 'file-history-delta', messageId: randomUUID(), snapshotMessageId: randomUUID(), trackingPath: 'scratch/check.mjs',
      backup: { backupFileName: null, version: 1, backupTime: new Date().toISOString(), realParentDir: 'scratch' }, timestamp: new Date().toISOString() });
    record({ type: 'user', message: { content: [{ type: 'tool_result', content: 'tool result' }] } });
    answer(`TABLE ANSWER ${id}`); user('owner follow-up'); answer('UNRELATED LATEST ANSWER');
  });
} else if (process.argv.includes('--station')) {
  const originalWrite=process.stdout.write.bind(process.stdout);
  process.stdout.write=(data,...args)=>{
    if(existsSync(path.join(process.env.STATION_HOME,'cursor-probe')) && String(data).includes('Drag divider to resize') && !String(data).startsWith('\x1b[?25l'))
      appendFileSync(path.join(process.env.STATION_HOME,'trace.jsonl'),JSON.stringify({type:'visible-shelf-paint'})+'\n');
    return originalWrite(data,...args);
  };
  await main(['--seats', 'claude,claude:default:default:auto', '--name', 'Table safeguards'], {
    pasteClipboard: async () => ({ text: await readFile(path.join(process.env.STATION_HOME, 'clipboard.txt'), 'utf8'), image: null }),
  });
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-table-pty-'));
  await writeFile(path.join(root, 'mode'), 'normal');
  await writeFile(path.join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${self}" --agent %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${self}" --agent "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, STATION_HOME: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [root, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  const proc = pty.spawn(process.execPath, [self, '--station'], { cwd: root, env, cols: 160, rows: 40 });
  const display = new headless.Terminal({ cols: 160, rows: 40, allowProposedApi: true });
  display.onData(data => proc.write(data));
  let output = '', exited = false;
  proc.onData(data => { output += data; display.write(data); }); proc.onExit(() => { exited = true; });
  const screen = () => Array.from({ length: display.rows }, (_, row) => display.buffer.active.getLine(display.buffer.active.viewportY + row)?.translateToString(true) || '').join('\n');
  const until = async (predicate, name) => { for (let i = 0; i < 180 && !await predicate() && !exited; i++) await delay(100); assert.ok(await predicate(), `${name}: ${output.slice(-1800)}\n${root}`); };
  const key = async value => { proc.write(value); await delay(130); };
  const run = () => {
    try { return loadHistory({ dir: root }).find(item => item.active); }
    catch(error) { if(!runId && /no such table: stations/.test(error.message)) return undefined; throw error; }
  };
  const trace = async () => (await readFile(path.join(root, 'trace.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  let runId;
  const events = () => { const read = readLedger(path.join(root, 'station.db')); try { return read.events(runId); } finally { read.close(); } };
  try {
    await until(() => run()?.seats.every(seat => seat.attention?.watcher?.state === 'healthy'), 'healthy agents');
    const initial = run(); runId = initial.id; const ids = initial.seats.map(seat => seat.nativeId);
    await writeFile(path.join(root, `control-${ids[0]}`), 'busy');
    await until(() => run().seats[0].attention.activity === 'working', 'busy native turn');
    await key('\x1b`');
    display.resize(118, 30); proc.resize(118, 30); await delay(300);
    await writeFile(path.join(root,'cursor-probe'),'active');
    await key('Cursor testxy'); await key('\x7f\x7fZ');
    await until(()=>screen().includes('Cursor testZ'),'coalesced backspace edits are applied in order');
    for(let tick=0;tick<3;tick++) {
      await delay(1100);
      assert.equal(display.buffer.active.cursorY,26,'heartbeat keeps caret inside table input');
      const line=display.buffer.active.getLine(display.buffer.active.baseY+26).translateToString(true);
      assert.ok(line.trimEnd().endsWith('Cursor testZ'));
      assert.equal(display.buffer.active.cursorX,displayWidth(line.trimEnd()),'backspace caret remains at actual draft end');
    }
    assert.equal((await trace()).filter(e=>e.type==='visible-shelf-paint').length,0,'no separate visible-cursor shelf paint between table frames');
    await unlink(path.join(root,'cursor-probe')); await key('\x15');
    await writeFile(path.join(root, 'clipboard.txt'), 'Long draft 漢字 cafe\u0301 '.repeat(150) + 'TAIL 漢字e\u0301');
    await key('\x16'); await until(() => screen().includes('TAIL'), 'Ctrl+V text lands in table input');
    assert.equal(display.buffer.active.cursorY, 26, 'cursor stays on input row, not the terminal footer');
    for (const width of [160, 118]) {
      display.resize(width, 30); proc.resize(width, 30);
      await until(() => display.buffer.active.getLine(display.buffer.active.baseY + display.buffer.active.cursorY)?.translateToString(true, 0, display.cols).trimEnd().normalize('NFC').endsWith('漢字é'), 'resized mixed draft repaint');
      const buffer = display.buffer.active;
      const tail = buffer.getLine(buffer.baseY + buffer.cursorY).translateToString(true, 0, display.cols).trimEnd();
      assert.ok(tail.normalize('NFC').endsWith('漢字é'), JSON.stringify({ width, tail, x: buffer.cursorX, y: buffer.cursorY }));
      assert.equal(buffer.cursorX, displayWidth(tail), 'mixed wide/combining paste caret stays at the tail after resize');
    }
    assert.ok(screen().includes('Alt+V paste'), 'narrow input hint remains inside the box');
    assert.equal((await trace()).filter(item => item.type === 'paste').length, 0, 'clipboard does not reach either seat before Enter');
    await key('\x15');
    await key('\x1b[200~Decision'); await key('\r\ntopic'); await key('\x1b[201~');
    assert.equal((await trace()).filter(item => item.type === 'paste').length, 0, 'split multiline paste cannot submit');
    await key('\r');
    await until(() => screen().includes('Cannot convene: claude'), 'busy admission refused');
    assert.equal((await trace()).filter(item => item.type === 'paste').length, 0);
    assert.ok(!screen().includes('launch: manual') && screen().includes('BYPASS') && screen().includes('asked, not enforced'));
    await writeFile(path.join(root, `control-${ids[0]}`), 'finish');
    await until(() => run().seats[0].attention.activity === 'completed', 'ready again');
    await writeFile(path.join(root, 'mode'), 'menu'); await key('\r');
    await until(() => events().some(event => event.type === 'table-blocked'), 'approval between paste and Enter blocks table');
    assert.equal((await trace()).filter(item => item.type === 'MENU ENTER').length, 0);
    assert.ok(screen().includes('Table blocked:'));
    await writeFile(path.join(root, 'mode'), 'normal');
    for (const digit of ['1', '2']) { await key('\x1b' + digit); await key('\x03'); }
    await until(() => run().seats.every(seat => seat.attention.activity === 'idle'), 'owner cleared abandoned drafts');
    await key('\x1b`'); await key('\r');
    await until(() => events().some(event => event.type === 'table-ended' && event.payload.reason === 'completed'), 'three correlated rounds finish');
    const answers = events().filter(event => event.type === 'table-answer');
    assert.equal(answers.length, 6); assert.ok(answers.every(event => event.payload.text.startsWith('TABLE ANSWER')));
    assert.ok(answers.every(event => !event.payload.text.includes('UNRELATED')));
    assert.equal(events().filter(event => event.type === 'table-response-match').length, 6);
    assert.deepEqual(run().seats.map(seat=>seat.nativeId),ids,'table uses the existing native conversations');
    assert.equal((await trace()).filter(item=>item.type==='launch').length,2,'table never relaunches agents or starts blank conversations');
    // Open a local usage menu while the blind requests are still running.
    // Completing those requests holds the unsent floor step until Esc + Enter.
    const endedBefore = events().filter(e => e.type === 'table-ended').length;
    await writeFile(path.join(root, 'mode'), 'hold');
    await key('Local command recovery'); await key('\r');
    await until(() => run().seats.every(s => s.attention.activity === 'working'), 'second table running');
    await key('\x1b1'); await key('/usage'); await key('\r');
    await until(() => screen().includes('Usage details'), 'native usage menu open');
    for (const id of ids) await writeFile(path.join(root, `control-${id}`), 'finish');
    await until(() => events().some(e => e.type === 'table-held' && e.payload.reason.includes('/usage')), 'next floor step held by usage menu');
    const heldSubmits = (await trace()).filter(item => item.type === 'submit').length;
    await delay(31000); // Exceeds the real progress watchdog, no shortened fake clock.
    assert.ok(run().seats.every(s => s.attention.watcher.state === 'healthy'), '/usage must not fault native tracking');
    assert.equal((await trace()).filter(item => item.type === 'submit').length, heldSubmits, 'no unsolicited retry into a local menu');
    await key('\x1b`'); await key('\r');
    await until(() => screen().includes('Still held:'), 'retry still refuses open menu');
    await key('\x1b1'); await key('\x1b');
    await writeFile(path.join(root, 'mode'), 'normal'); await key('\x1b`'); await key('\r');
    await until(() => events().filter(e => e.type === 'table-ended').length > endedBefore, 'table resumes after usage closes');
    assert.equal(events().filter(e => e.type === 'table-answer').length, 12, 'both discussions keep each answer once');
    assert.equal(events().filter(e => e.type === 'table-started').length, 2, 'recovery never starts a replacement discussion');
    // History recall bypasses Rellin's typed draft. Read the command at the
    // live native input, and keep the gate through a nested-menu Escape.
    await writeFile(path.join(root, 'mode'), 'hold');
    await key('History menu recovery'); await key('\r');
    await until(() => run().seats.every(s => s.attention.activity === 'working'), 'third table running');
    await key('\x1b1'); await key('\x1b[A');
    await until(() => screen().includes('❯ /config'), 'history restored config command');
    await key('\r'); await until(() => screen().includes('Settings'), 'recalled settings dialog');
    await key('\r'); await until(() => screen().includes('Theme choices'), 'nested settings dialog');
    for (const id of ids) await writeFile(path.join(root, `control-${id}`), 'finish');
    await until(() => events().some(e => e.type === 'table-held' && e.payload.reason.includes('/config')), 'history menu holds the unsent floor');
    const historySubmits = (await trace()).filter(e => e.type === 'submit').length;
    await key('\x1b'); await until(() => screen().includes('Settings'), 'Escape returns to parent, not input');
    await key('\x1b`'); await key('\r');
    await until(() => screen().includes('Still held:'), 'parent menu still blocks retry');
    assert.equal((await trace()).filter(e => e.type === 'submit').length, historySubmits);
    await key('\x1b1'); await key('\x1b');
    await writeFile(path.join(root, 'mode'), 'normal'); await key('\x1b`'); await key('\r');
    await until(() => events().filter(e => e.type === 'table-ended' && e.payload.reason === 'completed').length === 3, 'history menu recovery completes the same table');
    assert.equal(events().filter(e => e.type === 'table-answer').length, 18);
    assert.equal(events().filter(e => e.type === 'table-response-match').length, 18);
    assert.equal((await trace()).filter(e => e.type === 'launch').length, 2);
    // Reader acknowledgement names the snapshot version, even while the agent
    // finishes another response behind it. Reader/navigation keys stay local.
    await key('\x1b1');
    const beforeRead = run().seats[0].attention.completionVersion;
    const inputCount = (await trace()).filter(item => item.type === 'input').length;
    await key('\x1bt'); await until(() => screen().includes(`m read v${beforeRead}`), 'versioned read control');
    await writeFile(path.join(root, `control-${ids[0]}`), 'finish');
    await until(() => run().seats[0].attention.completionVersion > beforeRead, 'new completion while reader open');
    await key('m');
    await until(() => run().seats[0].attention.readVersion === beforeRead, 'snapshot acknowledged');
    assert.equal(run().seats[0].attention.unread, true);
    await key('\x1b'); await key('\x1bn');
    await until(() => screen().includes('2 claude-2'), 'attention navigation');
    assert.equal((await trace()).filter(item => item.type === 'input').length, inputCount, 'read and navigation do not type into agent');
    await key('\x1b`');
    const beforeFailureTrial = (await trace()).filter(item => item.type === 'submit').length;
    await writeFile(path.join(root, 'mode'), 'hold'); await key('Watcher failure trial'); await key('\r');
    await until(async () => run().seats.every(seat => seat.attention.activity === 'working')
      && (await trace()).filter(item => item.type === 'submit').length === beforeFailureTrial + 2, 'both native requests accepted before corrupting history');
    const submits = (await trace()).filter(item => item.type === 'submit').length;
    const blockedBefore = events().filter(event => event.type === 'table-blocked').length;
    await writeFile(path.join(root, `control-${ids[0]}`), 'corrupt');
    await until(() => run().seats[0].attention.watcher.state === 'error' && events().filter(event => event.type === 'table-blocked').length > blockedBefore, 'watcher failure stops coordination');
    await delay(700); assert.equal((await trace()).filter(item => item.type === 'submit').length, submits);
    assert.ok(screen().includes('unverified'));
    await key('\x1b`'); await until(() => screen().includes('unverified') && screen().includes('Alt+1 focus'), 'watcher failure and focus action visible on the shelf');
    await key('\x1bn'); await until(() => screen().includes('Alt+S inspect / restart'), 'focused watcher failure offers recovery');
    await key('\x11'); await until(() => exited, 'quit');
    console.log('Table safeguards lifecycle passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (!exited) proc.kill(); display.dispose(); }
  process.exit(process.exitCode || 0);
}
