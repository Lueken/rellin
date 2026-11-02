import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { initialAttention, reduceAttention, createAttentionTracker } from '../station-attention.mjs';
import { openLedger, readLedger } from '../station-ledger.mjs';
import { tailNativeFile } from '../native-events.mjs';
import { reduce, stationSeats } from '../station.mjs';

const apply = (state, type, extra = {}) => reduceAttention(state, { type, at: 100, ...extra });
const started = () => apply(initialAttention(), 'started');

test('native completions create unread results exactly once and stale reads cannot clear newer answers', () => {
  let s = apply(started(), 'completed', { id: 'thread:a' });
  assert.equal(s.completionVersion, 1);
  assert.equal(s.unread, true);
  assert.equal(apply(s, 'completed', { id: 'thread:a' }), s);
  s = apply(s, 'completed', { id: 'thread:b' });
  assert.equal(apply(s, 'completed', { id: 'thread:a' }), s, 'non-adjacent replay is ignored');
  s = apply(s, 'acknowledge', { version: 1 });
  assert.equal(s.unread, true);
  assert.equal(s.readVersion, 1);
  assert.equal(apply(s, 'acknowledge', { version: 3 }), s, 'future reads are rejected');
  s = apply(s, 'acknowledge', { version: 2 });
  assert.equal(s.unread, false);
  s = apply(s, 'completed', { id: 'other-thread:a' });
  assert.equal(s.completionVersion, 3);
  assert.equal(s.unread, true);
});

test('silence and keystrokes never prove completion or acknowledge previous work', () => {
  let s = apply(started(), 'submitted');
  assert.equal(s.activity, 'working');
  assert.equal(s.source, 'input');
  assert.equal(apply(s, 'quiet', { native: true }), s);
  s = apply(s, 'quiet', { native: false });
  assert.equal(s.activity, 'idle');
  assert.equal(s.completionVersion, 0);
  s = apply(s, 'completed', { id: 'done' });
  s = apply(s, 'submitted');
  assert.equal(s.unread, true);
  assert.equal(s.completionVersion, 1);
});

test('startup menus, native errors, retries, interrupts and table timeouts have distinct states', () => {
  let s = apply(started(), 'prompt', { id: 'menu' });
  assert.equal(s.activity, 'waiting');
  assert.equal(s.waitReason, 'prompt');
  assert.equal(apply(s, 'prompt', { id: 'menu' }), s, 'polling does not churn storage');
  s = apply(s, 'prompt-cleared');
  assert.equal(s.activity, 'working');
  s = apply(s, 'error', { code: 'provider-error' });
  assert.equal(s.activity, 'failed');
  assert.equal(s.lifecycle, 'running', 'provider errors may retry without a new process');
  assert.equal(apply(s, 'quiet'), s);
  assert.equal(apply(s, 'prompt', { id: 'menu' }), s);
  s = apply(s, 'turn-started');
  assert.equal(s.error, null);
  assert.equal(s.source, 'native');
  s = apply(s, 'timeout');
  assert.equal(s.waitReason, 'timeout');
  s = apply(s, 'completed', { id: 'late' });
  assert.equal(s.waitReason, null);
  assert.equal(s.unread, true);
  s = apply(s, 'interrupted');
  assert.equal(s.activity, 'idle');
  assert.equal(s.unread, true);
});

test('shutdown and failure preserve unread; late events cannot revive a stopped process', () => {
  const completed = apply(started(), 'completed', { id: 'answer' });
  const failed = apply(completed, 'exited', { code: 7 });
  assert.equal(failed.lifecycle, 'failed');
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.unread, true);
  assert.equal(apply(failed, 'turn-started'), failed);
  const stopped = apply(completed, 'stopped');
  assert.equal(stopped.lifecycle, 'stopped');
  assert.equal(stopped.activity, 'completed');
  assert.equal(stopped.unread, true);
  assert.equal(apply(stopped, 'completed', { id: 'late' }), stopped);
  assert.equal(apply(started(), 'launch-failed').error, 'launch-failed');
  const restored = initialAttention(failed);
  assert.equal(restored.lifecycle, 'starting');
  assert.equal(restored.error, null);
  assert.equal(restored.completionVersion, 1);
  assert.equal(restored.unread, true);
  assert.equal(apply(restored, 'completed', { id: 'answer' }), restored);
});

test('view, focus, usage and transcript navigation leave attention unchanged', () => {
  const seats = stationSeats('claude,codex');
  const tracker = createAttentionTracker(seats, () => {});
  tracker.dispatch(1, { type: 'completed', id: 'done' });
  const before = tracker.snapshot(1);
  let state = { seats, focus: 0, address: [0], view: 'gallery', composer: null };
  for (const action of [{ type: 'focus', target: 1 }, { type: 'view' }, { type: 'usage' }, { type: 'transcript' }, { type: 'resize' }]) [state] = reduce(state, action);
  assert.deepEqual(tracker.snapshot(1), before);
  const copy = tracker.snapshot(1);
  copy.completionIds.push('mutated');
  assert.deepEqual(tracker.snapshot(1), before, 'consumers receive isolated snapshots');
});

test('snapshots and transition records survive reopen and resume with explicit acknowledgement', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-attention-'));
  const seats = stationSeats('claude');
  const ledger = await openLedger({ dir, cwd: dir, seats: [{ seat: 'claude', agent: 'claude' }], repo: { root: null, remote: null } });
  const tracker = createAttentionTracker(seats, (index, snapshot, cause) => ledger.attention(index, snapshot, cause));
  tracker.dispatch(0, { type: 'started' });
  tracker.dispatch(0, { type: 'completed', id: 'a' });
  tracker.dispatch(0, { type: 'completed', id: 'b' });
  tracker.acknowledge(0, 1);
  tracker.dispatch(0, { type: 'stopped' });
  ledger.close();
  const read = readLedger(path.join(dir, 'station.db'));
  const saved = read.stations()[0].seats[0].attention;
  assert.deepEqual(saved, tracker.snapshot(0));
  assert.equal(saved.unread, true);
  const events = read.events(ledger.id);
  assert.equal(events.length, 5);
  assert.deepEqual(events.at(-1).payload.snapshot, saved);
  assert.equal(events.at(-1).payload.cause, 'stopped');
  read.close();
  const resumed = [{ attention: saved }];
  const second = createAttentionTracker(resumed, () => {});
  assert.equal(second.snapshot(0).unread, true);
  second.acknowledge(0, 2);
  assert.equal(second.snapshot(0).unread, false);
});

test('Grok completions without native IDs keep stable distinct byte identities across rereads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-grok-events-'));
  const file = path.join(dir, 'history.jsonl');
  const record = JSON.stringify({ type: 'assistant', content: 'same answer 🙂' }) + '\n';
  await writeFile(file, record);
  const events = [];
  let stop = tailNativeFile(file, 'grok', event => events.push(event));
  try {
    for (let i = 0; i < 20 && !events.length; i++) await delay(50);
    await appendFile(file, record);
    for (let i = 0; i < 20 && events.length < 2; i++) await delay(50);
    assert.equal(events.length, 2);
    assert.notEqual(events[0].id, events[1].id);
    stop();
    const replay = [];
    stop = tailNativeFile(file, 'grok', event => replay.push(event));
    for (let i = 0; i < 20 && replay.length < 2; i++) await delay(50);
    assert.deepEqual(replay.map(event => event.id), events.map(event => event.id));
  } finally { stop(); }
});
