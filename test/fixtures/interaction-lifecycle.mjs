import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { main } from '../../station.mjs';
import { clipboardDraft } from '../../station-clipboard.mjs';
import { openLink } from '../../station-links.mjs';
import { loadHistory } from '../../station-history.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFJkAAAAASUVORK5CYII=';
const self = fileURLToPath(import.meta.url);
if (process.argv.includes('--agent')) {
  const id = process.argv[process.argv.indexOf('--session-id') + 1], root = process.env.STATION_HOME;
  const folder = path.join(root, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const at=Date.now();
  await writeFile(path.join(folder, id + '.jsonl'), [
    {type:'user',timestamp:new Date(at-1000).toISOString(),message:{content:'fixture request'}},
    { type: 'assistant', timestamp:new Date(at).toISOString(), message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: '[Report](report.html)' }], usage:{cache_read_input_tokens:14000,cache_creation_input_tokens:1000,cache_creation:{ephemeral_5m_input_tokens:1000,ephemeral_1h_input_tokens:0}} } }
  ].map(row=>JSON.stringify(row)).join('\n') + '\n');
  process.stdout.write(`\x1b]8;;${pathToFileURL(path.join(root, 'report.html')).href}\x1b\\CLICK_REPORT\x1b]8;;\x1b\\\r\nAGENT READY\r\nNEXT LINE\r\n`);
  process.stdin.setRawMode?.(true); process.stdin.resume();
  process.stdin.on('data', data => { void appendFile(path.join(root, `input-${id}.txt`), data); });
} else if (process.argv.includes('--station')) {
  const root = process.env.STATION_HOME; let captures = 0;
  await main(['--seats', 'claude,claude'], {
    copyClipboard: async text => { await appendFile(path.join(root, 'copies.jsonl'), JSON.stringify({ text }) + '\n'); return 'Copied to clipboard.'; },
    pasteClipboard: () => clipboardDraft({ dir: root, read: async () => {
      const count = ++captures; await delay(700);
      return count === 3 ? { type: 'text', text: 'clipboard text' } : { type: 'image', data: png };
    } }),
    activateLink: link => openLink(link, { openFile: async file => {
      await appendFile(path.join(root, 'opens.jsonl'), JSON.stringify({ file }) + '\n'); return { notice: 'Link opened in fixture' };
    } }),
  });
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-interaction-'));
  await writeFile(path.join(root, 'report.html'), '<h1>Report</h1>');
  await writeFile(path.join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${self}" --agent %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${self}" --agent "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, STATION_HOME: root, CLAUDE_CONFIG_DIR: root, CODEX_HOME: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = [root, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  const proc = pty.spawn(process.execPath, [self, '--station'], { cwd: root, env, cols: 150, rows: 35 });
  const display = new headless.Terminal({ cols: 150, rows: 35, allowProposedApi: true });
  let output = '', exited = false;
  proc.onData(data => { output += data; display.write(data); }); proc.onExit(() => { exited = true; });
  const until = async (predicate, name) => { for (let i = 0; i < 120 && !await predicate() && !exited; i++) await delay(100); assert.ok(await predicate(), `${name}: ${output.slice(-1300)}`); };
  const locate = text => {
    const buffer = display.buffer.active;
    for (let row = 0; row < display.rows; row++) { const col = buffer.getLine(buffer.viewportY + row)?.translateToString(true).indexOf(text) ?? -1; if (col >= 0) return { x: col + 2, y: row + 1 }; }
    return null;
  };
  const click = (point, ctrl = true) => proc.write(`\x1b[<${ctrl ? 16 : 0};${point.x};${point.y}M\x1b[<${ctrl ? 16 : 0};${point.x};${point.y}m`);
  const contents = file => readFile(path.join(root, file), 'utf8').catch(() => '');
  try {
    await until(() => locate('CLICK_REPORT'), 'agent link visible');
    const ids = loadHistory({ dir: root })[0].seats.map(seat => seat.nativeId);
    const first = `input-${ids[0]}.txt`, second = `input-${ids[1]}.txt`;
    proc.write('\x1b[<0;26;2M\x1b[<32;40;2M\x1b[<0;40;2m');
    await until(() => locate('CLICK_REPORT')?.x === 42, 'drag widens shelf and moves native content');
    assert.equal(await contents('copies.jsonl'), '', 'divider drag is not a text selection');
    assert.equal(await contents(first), '', 'divider drag never reaches native input');
    await until(()=>locate('1k wrote'),'observed cache write count in shelf');
    proc.write('\x1bu');await until(()=>locate('Cache reminders off'),'usage opens with reminders off');
    await until(()=>locate('Write window'),'observed write window in usage');
    proc.write('r');await until(()=>locate('Cache reminders on'),'reminders toggle');
    proc.write('s');await until(()=>locate('Reminders snoozed'),'snooze applies to focused seat');
    assert.equal(JSON.parse(await contents('station-ui.json')).cacheReminders,true);
    assert.equal(JSON.parse(await contents('station-ui.json')).shelfWidth,40);
    assert.equal(await contents(first),'','usage reminder controls never reach agent input');
    proc.write('\x1b');await until(()=>locate('CLICK_REPORT'),'usage closes');
    click({x:4,y:7},false);await until(()=>locate('Cache reminders on'),'cache row click opens details');
    proc.write('\x1b[6~');await delay(100);assert.equal(await contents(first),'','usage scrolling never reaches agent input');
    proc.write('\x1b');await until(()=>locate('CLICK_REPORT'),'cache click details close');
    proc.write('\x1b`'); await until(() => locate('type a topic'), 'Ledger opens');
    proc.write('\x1b[<0;40;2M\x1b[<32;46;2M\x1b[<0;46;2m');
    await until(() => locate('RELLIN · table')?.x === 49, 'Ledger work surface follows divider');
    proc.write('\x1b`');
    await until(() => locate('CLICK_REPORT')?.x === 48, 'Console retains Ledger shelf width');
    click(locate('CLICK_REPORT'), false); await delay(150); assert.equal(await contents('opens.jsonl'), '');
    click(locate('CLICK_REPORT')); await until(async () => (await contents('opens.jsonl')).includes('report.html'), 'Ctrl click opens file');
    assert.equal(await contents(first), '', 'mouse events never reach the agent');
    proc.write('\x1bs'); await until(()=>locate('Manage seats'),'seat popup before selection');
    proc.write('\x1b'); await until(()=>!locate('Manage seats'),'popup dismissed');
    assert.notEqual(display.modes.mouseTrackingMode,'none','Rellin restores mouse ownership after overlays');
    const line = locate('AGENT READY'), start={x:line.x-1,y:line.y},end = { x:start.x+8,y:start.y+1 };
    proc.write(`\x1b[<0;${start.x};${start.y}M\x1b[<32;${end.x};${end.y}M\x1b[<0;${end.x};${end.y}m`);
    await until(async () => (await contents('copies.jsonl')).trim().length > 0, 'drag copies selected text');
    assert.equal(JSON.parse((await contents('copies.jsonl')).trim().split('\n')[0]).text,'AGENT READY\nNEXT LINE','multi-line copy contains only native content, never shelf text');
    proc.write('\x03');
    await until(async () => (await contents('copies.jsonl')).trim().split('\n').length === 2, 'Ctrl C copies selection again');
    assert.equal(await contents(first), '', 'Ctrl C with selection never reaches the agent');
    assert.ok(loadHistory({ dir: root })[0].seats.every(seat => seat.attention.lifecycle === 'running'));
    click(locate('AGENT READY'), false); // Clear selection before the next interaction.
    output = ''; proc.write('\x1bv'); await until(() => output.includes('Reading clipboard'), 'clipboard starts'); proc.write('\x1b2');
    await until(async () => (await contents(first)).includes('.png'), 'image goes to initiating seat');
    assert.equal(await contents(second), '');
    const pasted = await contents(first); assert.ok(!pasted.includes('\r'));
    const image = /"([^"]+\.png)"/.exec(pasted)[1]; assert.equal((await readFile(image)).toString('base64'), png);
    proc.write('\x1b!'); await delay(100); output = ''; proc.write('\x1bv');
    await until(() => output.includes('Reading clipboard'), 'composer capture starts');
    proc.write('\x1b'); await delay(100); proc.write('\x1b!');
    await until(() => output.includes('Paste failed:'), 'closed composer cannot receive delayed image');
    proc.write('\x1b'); await delay(100); proc.write('\x16');
    await until(async () => (await contents(second)).includes('clipboard text'), 'Ctrl V text fallback');
    assert.ok(!(await contents(second)).includes('\r'));
    proc.write('\x1b1'); await delay(100); click({x:4,y:6},false);
    await until(() => locate('[Report]'), 'reader link visible');
    proc.write('\x1b[<0;46;2M\x1b[<32;38;2M\x1b[<0;38;2m');
    await until(() => locate('[Report]')?.x < 46, 'reader follows divider without reloading snapshot');
    click(locate('[Report]'));
    await until(async () => (await contents('opens.jsonl')).trim().split('\n').length === 2, 'reader Ctrl click opens file');
    assert.equal(await contents(first), pasted, 'reader mouse keys never reach native draft');
    click({x:4,y:6},false);
    await until(()=>loadHistory({dir:root})[0].seats[0].attention.readVersion===1,'click read acknowledges the displayed version');
    proc.write('\x1b'); await delay(100);
    const transcript=path.join(root,'projects',root.replace(/[^a-zA-Z0-9]/g,'-'),ids[0]+'.jsonl');
    await appendFile(transcript,'invalid-json\n');
    await until(()=>locate('Alt+S inspect'),'tracking fault exposes inspect action');
    click({x:4,y:6},false);await until(()=>locate('Manage seats'),'click inspect opens seat manager');
    proc.write('\x1b');await delay(100);proc.write('\x11'); await until(() => exited, 'quit');
    console.log('Interaction lifecycle passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (!exited) proc.kill(); display.dispose(); }
  process.exit(process.exitCode || 0);
}
