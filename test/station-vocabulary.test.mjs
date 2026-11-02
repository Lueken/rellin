import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { attentionPresentation, attentionLabel, attentionOrder, nextAttention, seatLabel, clipLabel, plainWidth } from '../station-vocabulary.mjs';
import { initialAttention, reduceAttention } from '../station-attention.mjs';
import { captureReadToken, applyReadToken, conversationKey, renderConversation } from '../station-conversation.mjs';
import { completedTurn } from '../native-events.mjs';
import { keyAction, reduce, renderStatus } from '../station.mjs';
import { consoleLayout, paintShelf } from '../station-view.mjs';

const ready = (extra = {}) => ({ seat: 'claude', color: '#abcdef', alive: true, nativeId: 'thread', attention: {
  ...initialAttention(), lifecycle: 'running', watcher: { state: 'healthy' }, activity: 'idle', source: 'native', completionVersion: 3, readVersion: 3, ...extra,
} });

test('shared states distinguish native facts, unread versions, uncertain evidence and process exit', () => {
  const show = extra => attentionPresentation(ready(extra), 84000);
  assert.equal(show({}).label, 'idle');
  assert.equal(show({ activity: 'working', turnStartedAt: 0 }).label, 'working 1:24');
  assert.equal(show({ activity: 'working', turnStartedAt: 0, source: 'input' }).label, 'working 1:24 ?inp');
  assert.equal(show({ activity: 'waiting', waitReason: 'prompt', promptKind: 'approval', source: 'screen' }).label, 'blocked · approval ?scr');
  assert.equal(show({ activity: 'completed', readVersion: 1 }).label, 'done · 2 unread');
  assert.equal(show({ activity: 'working', turnStartedAt: 0, readVersion: 2 }).unread, 1);
  assert.equal(show({ watcher: { state: 'error' }, activity: 'completed', readVersion: 1 }).label, 'unverified · 2 unread');
  assert.equal(show({ watcher: { state: 'pending' } }).kind, 'unverified');
  assert.equal(attentionPresentation({ alive: true, status: 'ready' }).kind, 'unverified');
  assert.equal(show({ activity: 'failed', error: 'provider-error', providerCode: '529' }).label, 'error · 529');
  assert.equal(show({ lifecycle: 'failed', exitCode: 1 }).label, 'exited 1 ?prc');
  assert.equal(show({ lifecycle: 'stopped', exitCode: 0 }).label, 'exited ?prc');
  assert.equal(show({ completionVersion: 0, readVersion: 0 }).label, 'empty');
  assert.equal(show({ activity: 'waiting', waitReason: 'timeout', source: 'timer' }).label, 'blocked · turn limit ?tmr');
  assert.equal(show({ source: 'screen' }).kind, 'unverified', 'silence cannot earn idle');
  assert.equal(attentionPresentation({ ...ready({ completionVersion: 0, readVersion: 0, source: 'process' }), resumeId: 'existing-chat' }).kind, 'unverified', 'missed completions do not make a resumed conversation empty');
});

test('an exited seat does not retain a live unverified warning in the status bar', () => {
  const seat = ready({ lifecycle: 'stopped', watcher: { state: 'error', error: 'old tracking failure' }, exitCode: 0 });
  seat.alive = false;
  const output = renderStatus({ seats: [seat], focus: 0, address: [0], view: 'gallery' }, 160);
  assert.doesNotMatch(output, /unverified|Tracking error/);
});

test('attention navigation orders uncertainty before unread and never acknowledges or sends a key to an agent', () => {
  const seats = [ready({ readVersion: 1 }), ready({ watcher: { state: 'error' } }), ready({ activity: 'waiting', waitReason: 'prompt' }), ready({ activity: 'failed', error: 'provider-error' })];
  assert.deepEqual(attentionOrder(seats), [2, 1, 3, 0]);
  assert.equal(nextAttention(seats, 2), 1);
  const state = { seats, focus: 2, view: 'table', address: [2] };
  const before = structuredClone(seats);
  const [next, effects] = reduce(state, keyAction('\x1bn', state));
  assert.equal(next.focus, 1); assert.equal(next.view, 'console'); assert.deepEqual(next.address, [2]);
  assert.deepEqual(effects, [{ type: 'layout' }]); assert.deepEqual(seats, before);
  assert.equal(keyAction('\x1bn', { ...state, composer: { text: '' } }).type, 'none');
  assert.equal(nextAttention([ready()], 0), null);
});

test('read controls keep the displayed snapshot version when another completion arrives', () => {
  const seat = ready({ readVersion: 1 }), token = captureReadToken(seat);
  seat.attention = reduceAttention(seat.attention, { type: 'completed', id: 'four' });
  const state = { seat: 0, messages: [{ role: 'assistant', text: 'snapshot', at: '' }], index: 0, query: '', scroll: 0, readToken: token };
  assert.match(renderConversation(state, [seat]).lines.join('\n'), /m read v3/);
  assert.equal(conversationKey('m', { ...state, searching: true }).type, 'text');
  const action = conversationKey('m', state);
  assert.equal(action.token.version, 3);
  assert.ok(applyReadToken(seat, action.token, version => { seat.attention = reduceAttention(seat.attention, { type: 'acknowledge', version }); return true; }));
  assert.equal(seat.attention.readVersion, 3); assert.equal(seat.attention.completionVersion, 4);
  assert.equal(attentionPresentation(seat).unread, 1);
  assert.equal(applyReadToken({ ...seat, nativeId: 'replacement' }, token, () => assert.fail('wrong conversation')), false);
  assert.equal(conversationKey('m', {}).type, 'none');
});

test('native provider codes survive tracking and display without invented HTTP codes', () => {
  const event = completedTurn({ type: 'system', subtype: 'api_error', error: { status: 529 } }, 'claude');
  const seat = ready(); seat.attention = reduceAttention(seat.attention, { type: 'error', code: 'provider-error', providerCode: event.providerCode });
  assert.equal(attentionLabel(seat), '▲ error · 529');
  assert.equal(completedTurn({ type: 'system', subtype: 'api_error' }, 'claude').providerCode, null);
  assert.doesNotMatch(attentionLabel(ready({ activity: 'failed', providerCode: '\x1b[2J529' })), /\x1b/);
});

test('BYPASS is inverse, manual is unmarked and clipping never leaves a partial escape sequence', async () => {
  assert.equal(seatLabel(ready()), 'claude');
  const bypass = { ...ready(), bypass: true };
  assert.match(seatLabel(bypass), /\x1b\[7mBYPASS\x1b\[27m/);
  for (const width of [24, 40, 80, 160]) {
    const status = renderStatus({ seats: [bypass], focus: 0, address: [0], view: 'gallery' }, width);
    assert.ok(plainWidth(status) <= width);
    assert.doesNotMatch(clipLabel(status, width).replace(/\x1b\[[0-9;]*m/g, ''), /\x1b/);
  }
  for (const width of [80, 160]) {
    const terminal = new headless.Terminal({ cols: width, rows: 24, allowProposedApi: true });
    const seats = [bypass, ready({ watcher: { state: 'error' }, readVersion: 1 })];
    await new Promise(resolve => terminal.write(paintShelf(consoleLayout(width, 24).shelf, seats, 0), resolve));
    const identity = terminal.buffer.active.getLine(2), header = identity.translateToString(true);
    assert.match(header, /BYPASS/);
    assert.ok(identity.getCell(header.indexOf('BYPASS')).isInverse());
    assert.match(terminal.buffer.active.getLine(9).translateToString(true), /unverified/);
    terminal.dispose();
  }
});
