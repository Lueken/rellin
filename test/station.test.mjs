import test from 'node:test';
import assert from 'node:assert/strict';
import { keyAction, makeWin32InputScrub, parseMouse, parseSeatSpec, reduce, renderStatus, stationSeats, wrapText } from '../station.mjs';
import { modelArgument, terminalCommand } from '../agents.mjs';

const plain = line => line.replace(/\x1b\[[0-9;]*m/g, '');
const state = overrides => ({ seats: stationSeats('claude,codex'), focus: 0, address: [0], composer: null, view: 'gallery', ...overrides });

test('a seat spec carries agent, model, effort and mode, with defaults', () => {
  assert.deepEqual(parseSeatSpec('claude'), { agent: 'claude', model: 'default', effort: 'default', mode: 'manual' });
  assert.deepEqual(parseSeatSpec('claude:opus:high:auto'), { agent: 'claude', model: 'opus', effort: 'high', mode: 'auto' });
  assert.deepEqual(parseSeatSpec('codex::xhigh'), { agent: 'codex', model: 'default', effort: 'xhigh', mode: 'manual' });
  const seat = stationSeats('claude:opus:high:auto,codex')[0];
  assert.equal(seat.model, 'opus');
  assert.equal(seat.bypass, true);
  assert.equal(stationSeats('claude,codex')[0].bypass, false);
});

test('a station seats one to four known agents, duplicates suffixed', () => {
  assert.deepEqual(stationSeats('claude,claude,codex').map(item => item.seat), ['claude', 'claude-2', 'codex']);
  assert.equal(stationSeats('claude,codex')[0].color, '#dba68c');
  assert.equal(stationSeats('claude,codex')[0].status, 'ready');
  assert.equal(stationSeats('claude').length, 1);
  assert.throws(() => stationSeats('claude,claude,claude,claude,claude'), /one to four/);
  assert.throws(() => stationSeats('claude,shell'), /Unknown seat "shell"/);
  assert.equal(stationSeats('claude,grok')[1].seat, 'grok');
});

test('a model choice lands as one safe argument on the right CLI flag', async () => {
  assert.equal(modelArgument('default'), undefined);
  assert.throws(() => modelArgument('-m evil'), /not valid/);
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const bin = await mkdtemp(path.join(os.tmpdir(), 'station-model-'));
  for (const name of ['claude', 'codex']) await writeFile(path.join(bin, process.platform === 'win32' ? `${name}.exe` : name), '', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    const claude = terminalCommand('claude', { model: 'opus', readDir: bin });
    const modelAt = claude.args.indexOf('--model');
    assert.ok(modelAt >= 0 && claude.args[modelAt + 1] === 'opus');
    assert.ok(modelAt < claude.args.indexOf('--add-dir'), 'model precedes the variadic --add-dir');
    assert.ok(terminalCommand('codex', { model: 'gpt-6-astra' }).args.join(' ').includes('-m gpt-6-astra'));
  } finally {
    process.env.PATH = previous;
  }
});

test('chords are consumed; everything else passes through to the focused seat', () => {
  const s = state();
  assert.deepEqual(keyAction('\x1b1', s), { type: 'focus', target: 0 });
  assert.deepEqual(keyAction('\x1b`', s), { type: 'view-table' });
  assert.deepEqual(keyAction('\x1b`', state({ composer: { targets: [0], text: '' } })), { type: 'compose', target: 'all' });
  assert.deepEqual(keyAction('\x1b@', s), { type: 'compose', target: 1 });
  assert.deepEqual(keyAction('\x1bg', s), { type: 'view' });
  assert.deepEqual(keyAction('\x1be', s), { type: 'table-end' });
  assert.deepEqual(keyAction('\x11', s), { type: 'quit' });
  assert.deepEqual(keyAction('\x1b3', s), { type: 'passthrough', data: '\x1b3' });
  assert.deepEqual(keyAction('\x1b', s), { type: 'passthrough', data: '\x1b' });
  assert.deepEqual(keyAction('\x1b[A', s), { type: 'passthrough', data: '\x1b[A' });
  assert.deepEqual(keyAction('\x1b\r', s), { type: 'passthrough', data: '\x1b\r' });
});

test('composer keys: type, newline on Alt+Enter, erase, paste unwrap, cancel', () => {
  const s = state({ composer: { targets: [1], text: 'hi' } });
  assert.deepEqual(keyAction('a', s), { type: 'type', text: 'a' });
  assert.deepEqual(keyAction('\x1b\r', s), { type: 'type', text: '\n' });
  assert.deepEqual(keyAction('\x7f', s), { type: 'erase' });
  assert.deepEqual(keyAction('\r', s), { type: 'send' });
  assert.deepEqual(keyAction('\x1b', s), { type: 'cancel' });
  assert.deepEqual(keyAction('\x1b[A', s), { type: 'none' });
  assert.deepEqual(keyAction('\x1b[200~two words\x1b[201~', s), { type: 'type', text: 'two words' });
});

test('the composer holds a target set: open selects, chords toggle, all is all', () => {
  let [s] = reduce(state(), { type: 'compose', target: 1 });
  assert.deepEqual(s.composer, { targets: [1], text: '' });
  [s] = reduce(s, { type: 'compose', target: 0 });
  assert.deepEqual(s.composer.targets, [0, 1]);
  [s] = reduce(s, { type: 'compose', target: 1 });
  assert.deepEqual(s.composer.targets, [0]);
  [s] = reduce(s, { type: 'compose', target: 'all' });
  assert.equal(s.composer.targets, 'all');
  [s] = reduce(s, { type: 'compose', target: 1 });
  assert.deepEqual(s.composer.targets, [1]);
});

test('sending moves the sticky address and routes to the set; focus never does', () => {
  const composing = state({ composer: { targets: 'all', text: ' ship it ' } });
  const [sent, effects] = reduce(composing, { type: 'send' });
  assert.equal(sent.composer, null);
  assert.equal(sent.address, 'all');
  assert.deepEqual(effects[0], { type: 'send', targets: 'all', text: 'ship it' });
  const [empty, none] = reduce(state({ composer: { targets: [], text: 'x' } }), { type: 'send' });
  assert.deepEqual(none, []);
  assert.ok(empty.composer);
  const [focused, focusEffects] = reduce(state({ address: [1] }), { type: 'focus', target: 1 });
  assert.deepEqual(focused.address, [1]);
  assert.deepEqual(focusEffects, [{ type: 'layout' }]);
});

test('ConPTY win32-input-mode requests never reach the buffer path unscrubbed', () => {
  const scrub = makeWin32InputScrub();
  assert.equal(scrub('ready\x1b[?9001hgo'), 'readygo');
  assert.equal(scrub('text\x1b[?90'), 'text');
  assert.equal(scrub('01hmore'), 'more');
  assert.equal(scrub('end\x1b'), 'end');
  assert.equal(scrub('[31mred'), '\x1b[31mred');
});

test('the status bar carries address and reachable navigation; states live on the shelf', () => {
  const working = state();
  const tracked = activity => ({ lifecycle: 'running', activity, source: 'native', watcher: { state: 'healthy' }, completionVersion: 1, readVersion: 1 });
  working.seats[0].attention = tracked('working');
  working.seats[1].attention = tracked('idle');
  const idle = plain(renderStatus(working, 220));
  assert.match(idle, /@1/);
  assert.match(idle, /Alt\+1\.\.4 focus/);
  const needy = state({ address: 'all' });
  needy.seats[0].attention = tracked('idle');
  needy.seats[1].attention = { ...tracked('waiting'), source: 'screen', waitReason: 'prompt' };
  const bar = plain(renderStatus(needy, 220));
  assert.match(bar, /@all/);
  assert.match(bar, /Alt\+N attention/);
  assert.ok(plain(renderStatus(needy, 40)).length <= 40);
});

test('mouse parsing: left press, drag and release; wheel and others ignored', () => {
  assert.deepEqual(parseMouse('\x1b[<0;10;5M'), [{ kind: 'press', x: 10, y: 5 }]);
  assert.deepEqual(parseMouse('\x1b[<32;11;5M'), [{ kind: 'drag', x: 11, y: 5 }]);
  assert.deepEqual(parseMouse('\x1b[<0;12;6m'), [{ kind: 'release', x: 12, y: 6 }]);
  assert.deepEqual(parseMouse('\x1b[<64;9;9M\x1b[<2;4;4M'), [{ kind: 'wheel', delta: 3, x: 9, y: 9 }]);
  assert.deepEqual(parseMouse('\x1b[<65;9;9M'), [{ kind: 'wheel', delta: -3, x: 9, y: 9 }]);
  assert.deepEqual(parseMouse('plain keys'), []);
});

test('Alt+U toggles the usage modal, which swallows every other key', async () => {
  assert.deepEqual(keyAction('\x1bu', state()), { type: 'usage' });
  const open = state({ usageOpen: true });
  assert.deepEqual(keyAction('\x1bu', open), { type: 'usage' });
  assert.deepEqual(keyAction('\x1b', open), { type: 'usage' });
  assert.deepEqual(keyAction('\x1b1', open), { type: 'none' });
  assert.deepEqual(keyAction('a', open), { type: 'none' });
  assert.deepEqual(keyAction('\x11', open), { type: 'quit' });
  const [opened, effects] = reduce(state(), { type: 'usage' });
  assert.equal(opened.usageOpen, true);
  assert.deepEqual(effects, [{ type: 'usageOpen' }]);
  assert.deepEqual(reduce(opened, { type: 'usage' })[1], [{ type: 'layout' }]);
  const { usageFromRecords } = await import('../station-turns.mjs');
  const claude = usageFromRecords([
    { type: 'assistant', message: { id: 'a', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } } },
    { type: 'assistant', message: { id: 'a', usage: { input_tokens: 12, output_tokens: 9, cache_read_input_tokens: 100 } } },
    { type: 'assistant', message: { id: 'b', usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 50 } } },
  ], 'claude');
  assert.deepEqual(claude, { input: 15, output: 11, cacheRead: 100, cacheWrite: 50 });
  const codex = usageFromRecords([
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, output_tokens: 7, cached_input_tokens: 30 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 90, output_tokens: 20, reasoning_output_tokens: 5, cached_input_tokens: 60 } } } },
  ], 'codex');
  assert.deepEqual(codex, { input: 90, output: 25, cacheRead: 60, cacheWrite: null });
  assert.equal(usageFromRecords([], 'claude'),null);
  assert.equal(usageFromRecords([], 'codex'),null);
  const { renderUsageModal, tokenLabel } = await import('../station-view.mjs');
  assert.equal(tokenLabel(1234), '1.2k');
  assert.equal(tokenLabel(2_500_000), '2.5M');
  const modal = renderUsageModal({ seats: state().seats, usage: [claude, null], width: 120, height: 30, colorOf: () => '' }).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert.match(modal, /1 claude/);
  assert.match(modal, /Usage unavailable/);
  assert.match(modal, /total/);
  const missing = renderUsageModal({ seats: state().seats, usage: [null, null], width: 54, height: 23, colorOf: () => '' });
  assert.match(missing, /No usage totals available/);
  assert.doesNotMatch(missing, /Reported total|input 0/);
});

test('composer text wraps at the pane width, newlines respected', () => {
  assert.deepEqual(wrapText('abcdef', 4), ['abcd', 'ef']);
  assert.deepEqual(wrapText('ab\ncd', 10), ['ab', 'cd']);
  assert.deepEqual(wrapText('', 10), ['']);
});
