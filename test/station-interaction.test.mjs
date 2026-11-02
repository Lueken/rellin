import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import headless from '@xterm/headless';
import { parseMouse, textLinks, terminalLinkAt, wrappedLinkAt, openLink } from '../station-links.mjs';
import { clipboardDraft, clipboardCommand, bracketedDraft, copyText } from '../station-clipboard.mjs';
import { keyAction, reduce, stationSeats } from '../station.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFJkAAAAASUVORK5CYII=', 'base64');
test('Ctrl+C copies a Rellin selection, but remains a native interrupt without one', () => {
  const state = { seats: stationSeats('codex'), focus: 0, view: 'gallery', selection: { seat: 0, moved: true } };
  const action = keyAction('\x03', state);
  assert.equal(action.type, 'copy-selection');
  assert.deepEqual(reduce(state, action)[1], [{ type: 'copy-selection' }]);
  for (const extra of [{ selection: null }, { selection: { seat: 0, moved: false } }, { selection: { seat: 1, moved: true } }]) {
    assert.deepEqual(keyAction('\x03', { ...state, ...extra }), { type: 'passthrough', data: '\x03' });
  }
  assert.equal(keyAction('\x03', { ...state, composer: { text: 'draft' } }).type, 'none');
});

test('Windows copy sends literal text on stdin and reports failures without touching the real clipboard', async () => {
  const value = 'STATUS OK\nUnicode ✓ and literal $env:NAME; `command`';
  let calls = 0;
  const result = await copyText(value, { platform: 'win32', run: async (command, input) => {
    calls++;
    assert.equal(Buffer.from(input, 'base64').toString('utf8'), value);
    const script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Clipboard\]::SetText/); assert.match(script, /ReadToEnd/);
    assert.ok(!script.includes(value)); assert.ok(command.args.includes('-STA'));
  } });
  assert.equal(result, 'Copied to clipboard.'); assert.equal(calls, 1);
  await assert.rejects(copyText('x', { platform: 'win32', run: async () => { throw new Error('Clipboard busy'); } }), /Clipboard busy/);
  await assert.rejects(copyText('', { platform: 'win32', run: () => assert.fail('must not erase clipboard') }), /No text/);
  let output = '';
  await copyText('fallback', { platform: 'linux', write: data => { output += data; } });
  assert.equal(output, '\x1b]52;c;' + Buffer.from('fallback').toString('base64') + '\x1b\\');
});

test('Ctrl mouse modifiers survive parsing while plain clicks retain their existing shape', () => {
  assert.deepEqual(parseMouse('\x1b[<16;5;8M\x1b[<16;5;8m'), [{ kind: 'press', x: 5, y: 8, ctrl: true }, { kind: 'release', x: 5, y: 8, ctrl: true }]);
  assert.deepEqual(parseMouse('\x1b[<0;5;8M'), [{ kind: 'press', x: 5, y: 8 }]);
  assert.equal(parseMouse('\x1b[<48;5;8M')[0].kind, 'drag');
});

test('visible link spans preserve labels, spaces, line numbers and safe web URLs', () => {
  const text = '[Review](<docs/report one.md:42>) and `src/main.cpp:10` plus [[Notes/Plan]] https://example.com/chart_(1).';
  const links = textLinks(text, process.cwd());
  assert.equal(links.length, 4);
  assert.equal(text.slice(links[0].start, links[0].end), '[Review](<docs/report one.md:42>)');
  assert.equal(links[0].target, path.resolve('docs/report one.md'));
  assert.equal(links.at(-1).target, 'https://example.com/chart_(1)');
  assert.equal(textLinks('[local.md](javascript:bad) [run](file:///C:/bad.exe)', process.cwd()).length, 0);
  assert.equal(wrappedLinkAt(text, 12, 1, 2, process.cwd()).target, links[0].target);
});

test('native OSC links and wrapped paths remain clickable after scrolling and resize', async () => {
  const terminal = new headless.Terminal({ cols: 20, rows: 6, scrollback: 100, allowProposedApi: true });
  const write = text => new Promise(resolve => terminal.write(text, resolve));
  try {
    await write('\x1b]8;;https://example.com/report\x1b\\REPORT\x1b]8;;\x1b\\\r\n`docs/a-long-report.md`\r\n');
    assert.equal(terminalLinkAt(terminal, 0, 3, process.cwd()).target, 'https://example.com/report');
    assert.equal(terminalLinkAt(terminal, 2, 0, process.cwd()).target, path.resolve('docs/a-long-report.md'));
    await write('\x1b]8;;javascript:bad\x1b\\README.md\x1b]8;;\x1b\\\r\n');
    assert.equal(terminalLinkAt(terminal, 3, 2, process.cwd()), null);
    await write('\r\n'.repeat(10));
    terminal.resize(24, 6); terminal.scrollToTop();
    assert.equal(terminalLinkAt(terminal, 0, 3, process.cwd()).target, 'https://example.com/report');
  } finally { terminal.dispose(); }
});

test('click routing reuses file handling and only dispatches HTTP(S) externally', async () => {
  let opened;
  await openLink({ kind: 'file', target: '/fixture/report.md' }, { openFile: async file => { opened = file; return { notice: 'ok' }; } });
  assert.equal(opened, '/fixture/report.md');
  let launches = 0;
  await openLink({ kind: 'url', target: 'https://example.com' }, { run: async () => { launches++; } });
  await assert.rejects(openLink({ kind: 'url', target: 'javascript:bad' }, { run: async () => { launches++; } }), /Only local files/);
  assert.equal(launches, 1);
});

test('clipboard screenshots persist as real PNG files outside the project and never submit', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-paste-'));
  const draft = await clipboardDraft({ dir, read: async () => ({ type: 'image', data: png.toString('base64') }) });
  assert.deepEqual(await readFile(draft.image), png);
  assert.ok(draft.image.startsWith(path.join(dir, 'attachments') + path.sep));
  assert.equal(draft.text, `"${draft.image}" `);
  const input = bracketedDraft(draft.text);
  assert.ok(input.startsWith('\x1b[200~')); assert.ok(input.endsWith('\x1b[201~'));
  assert.ok(!input.includes('\r'));
  const second = await clipboardDraft({ dir, read: async () => ({ type: 'image', data: png.toString('base64') }) });
  assert.notEqual(second.image, draft.image);
  const state = { seats: stationSeats('claude'), focus: 0, composer: null };
  for (const key of ['\x16', '\x1bv']) assert.deepEqual(reduce(state, keyAction(key, state))[1], [{ type: 'clipboard' }]);
  if (process.platform === 'win32') {
    const command = clipboardCommand(), script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
    assert.ok(command.args.includes('-STA')); assert.match(script, /GetImage/); assert.doesNotMatch(script, /SetImage|SetText|Clear\(/);
  }
});

test('clipboard failures create no attachment, and plain text cannot escape bracketed paste', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-paste-'));
  for (const content of [{ type: 'empty' }, { type: 'image', data: Buffer.from('not an image').toString('base64') }]) await assert.rejects(clipboardDraft({ dir, read: async () => content }));
  assert.deepEqual(await readdir(dir), []);
  const draft = await clipboardDraft({ dir, read: async () => ({ type: 'text', text: 'hello\r\n\tworld\x1b[201~\r' }) });
  assert.equal(draft.image, null); assert.ok(!draft.text.includes('\x1b')); assert.ok(!draft.text.includes('\r'));
  assert.ok(draft.text.includes('\tworld'));
  assert.equal((bracketedDraft(draft.text).match(/\x1b\[201~/g) || []).length, 1);
});
