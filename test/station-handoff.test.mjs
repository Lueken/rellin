import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StationHandoffs, handoffEnd, handoffMarker, handoffRequest, handoffText, waitForContinuation, renderHandoffPopup } from '../station-handoff.mjs';
import { openLedger, readLedger } from '../station-ledger.mjs';
import { keyAction, reduce, stationSeats } from '../station.mjs';

const summary = id => '# Handoff\n' + ['Goal', 'Current state', 'Decisions', 'Files', 'Open problems', 'Next steps'].map(heading => `## ${heading}\nDetails`).join('\n') + '\n' + handoffEnd(id);
const conversation = id => [{ role: 'user', text: handoffRequest(id) }, { role: 'assistant', text: summary(id) }];

test('only a complete response to the exact request is accepted', () => {
  assert.equal(handoffText(conversation('a'), 'a'), summary('a'));
  assert.equal(handoffText(conversation('old'), 'new'), null);
  assert.equal(handoffText(conversation('a').map(item => item.role === 'assistant' ? { ...item, text: item.text.replace(handoffEnd('a'), '') } : item), 'a'), null);
  assert.throws(() => handoffText([...conversation('a'), { role: 'user', text: 'change direction' }], 'a'), /another prompt/);
});

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-handoff-'));
  const seat = { agent: 'claude', alive: true, watcher: {}, nativeId: 'source', attention: { activity: 'idle', completionVersion: 0 } };
  let messages = [], submitted = 0, launched = 0;
  const manager = new StationHandoffs({
    dir, cwd: dir, timeoutMs: 30, pollMs: 1, getSeat: () => seat,
    persist: (_, job) => { seat.handoff = job; },
    read: async () => ({ messages }),
    submit: async (_, text) => {
      submitted++;
      const id = /Station handoff request ([a-f0-9-]+)/.exec(text)[1];
      messages = conversation(id);
      if (!options.timeout) seat.attention.completionVersion++;
    },
    launch: async (_, job) => { launched++; if (options.failLaunch && launched === 1) throw new Error('launch failed'); return { sourceArchiveId: 'archive', file: job.file }; },
    ...options.overrides,
  });
  return { dir, seat, manager, counts: () => ({ submitted, launched }), setMessages: next => { messages = next; } };
}

test('handoff saves Markdown and retries failed launch without another summary request', async () => {
  const f = await fixture({ failLaunch: true });
  const first = await f.manager.start(0);
  assert.equal(first.status, 'failed');
  assert.equal(await readFile(first.file, 'utf8'), summary(first.id) + '\n');
  assert.equal(path.dirname(first.file), path.join(f.dir, 'handoffs'));
  assert.equal(f.seat.nativeId, 'source');
  const second = await f.manager.start(0);
  assert.equal(second.status, 'done');
  assert.equal(second.sourceArchiveId, 'archive');
  assert.deepEqual(f.counts(), { submitted: 1, launched: 2 });
});

test('busy seats, active tables and unsupported agents do not receive a request', async () => {
  for (const change of [{ agent: 'grok' }, { alive: false }, { nativeId: null }, { attention: { activity: 'working' } }, { attention: { activity: 'waiting' } }]) {
    const f = await fixture(); Object.assign(f.seat, change);
    assert.equal((await f.manager.start(0)).status, 'failed');
    assert.equal(f.counts().submitted, 0);
  }
  const f = await fixture({ overrides: { tableActive: () => true } });
  assert.match((await f.manager.start(0)).error, /table discussion/);
});

test('duplicate starts share one job; timeout retains the original and accepts a late matching summary on retry', async () => {
  const f = await fixture({ timeout: true });
  const first = f.manager.start(0);
  assert.equal(f.manager.start(0), first);
  assert.equal((await first).status, 'failed');
  assert.deepEqual(f.counts(), { submitted: 1, launched: 0 });
  assert.equal((await f.manager.start(0)).status, 'done');
  assert.deepEqual(f.counts(), { submitted: 1, launched: 1 });
});

test('source advancement invalidates a saved summary; shutdown prevents a late continuation', async () => {
  const f = await fixture({ failLaunch: true });
  const job = await f.manager.start(0);
  f.setMessages([...conversation(job.id), { role: 'user', text: 'new work' }]);
  assert.equal((await f.manager.start(0)).status, 'done');
  assert.equal(f.counts().submitted, 2);
  const stopping = await fixture({ timeout: true });
  const promise = stopping.manager.start(0);
  stopping.manager.stop();
  await promise;
  assert.equal(stopping.counts().launched, 0);
});

test('startup handshake rejects early exits and supports cancellation', async () => {
  const emitter = new EventEmitter();
  const proc = { onData: cb => { emitter.on('data', cb); return { dispose: () => emitter.off('data', cb) }; }, onExit: cb => { emitter.on('exit', cb); return { dispose: () => emitter.off('exit', cb) }; } };
  const pending = waitForContinuation(proc, { onData: () => {}, settleMs: 10, timeoutMs: 50 });
  emitter.emit('data', 'starting'); emitter.emit('exit', { exitCode: 1 });
  await assert.rejects(pending, /exited during startup/);
  const controller = new AbortController();
  const cancelled = waitForContinuation(proc, { onData: () => {}, signal: controller.signal });
  controller.abort(); await assert.rejects(cancelled, /Rellin closed/);
  const ready = waitForContinuation(proc, { onData: () => {}, settleMs: 1 });
    let opened = false;
    ready.then(() => { opened = true; });
    emitter.emit('data', '\x1b[?9001h\x1b[2J');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(opened, false, 'terminal control traffic is not a running agent');
  emitter.emit('data', 'ready'); (await ready).dispose();
  assert.equal(emitter.listenerCount('data'), 0);
});

test('ledger archives original settings and links the replacement atomically', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-handoff-ledger-'));
  const original = { seat: 'claude', agent: 'claude', nativeId: 'original', model: 'opus', effort: 'high', bypass: false };
  const ledger = await openLedger({ cwd: dir, dir, seats: [original], name: 'Task', repo: { root: null, remote: null } });
  const link = ledger.continueSeat(0, { ...original, nativeId: 'fresh' }, { id: 'handoff', file: 'summary.md', sourceNativeId: 'original' });
  ledger.close();
  const reader = readLedger(path.join(dir, 'station.db'));
  const runs = reader.history();
  const source = runs.find(run => run.id === link.sourceArchiveId), target = runs.find(run => run.id === ledger.id);
  assert.equal(source.seats[0].nativeId, 'original');
  assert.equal(source.seats[0].model, 'opus');
  assert.equal(source.seats[0].handoffTo.destinationStationId, ledger.id);
  assert.equal(target.seats[0].nativeId, 'fresh');
  assert.equal(target.seats[0].handoffFrom.sourceArchiveId, source.id);
  assert.equal(reader.events(ledger.id).at(-1).type, 'seat-handoff');
  reader.close();
});

test('Alt+H opens the action panel without sending input to the agent', () => {
  const state = { seats: stationSeats('claude'), focus: 0, composer: null };
  assert.deepEqual(reduce(state, keyAction('\x1bh', state))[1], [{ type: 'handoff' }]);
});

test('empty conversations have an actionable message and the popup leaves surrounding panes intact', async () => {
  const f = await fixture(); f.seat.nativeId = null;
  assert.throws(() => f.manager.check(0), /Send a first message/);
  assert.deepEqual(f.counts(), { submitted: 0, launched: 0 });
  const popup = renderHandoffPopup({ seat: { seat: 'codex', agent: 'codex' } }, 120, 40);
  assert.ok(!popup.includes('\x1b[2J'), 'popup must not clear the terminal');
  const positions = [...popup.matchAll(/\x1b\[(\d+);(\d+)H/g)].map(match => [Number(match[1]), Number(match[2])]);
  assert.ok(positions.every(([row, col]) => row > 1 && row < 40 && col > 1));
  const small = renderHandoffPopup({ seat: { seat: 'codex', agent: 'codex' }, error: 'long '.repeat(100) }, 30, 12);
  assert.ok([...small.matchAll(/\x1b\[(\d+);(\d+)H/g)].every(match => Number(match[1]) <= 12));
});
