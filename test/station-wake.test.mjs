import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTurnWatcher } from '../station-turns.mjs';
import { tailNativeFile } from '../native-events.mjs';
import { initialAttention, reduceAttention } from '../station-attention.mjs';
import { readinessProblem } from '../station-coordination.mjs';
import { codexStore } from './fixtures/codex-store.mjs';

const jsonl = records => records.map(JSON.stringify).join('\n') + '\n';
const user = text => ({ type: 'user', uuid: randomUUID(), message: { content: text } });
const answer = text => ({ type: 'assistant', message: { id: randomUUID(), stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const overnight = 8 * 60 * 60_000;

async function fixture(agent) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-wake-'));
  const env = agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', before = process.env[env];
  process.env[env] = home;
  const id = randomUUID(), owner = randomUUID(), events = [], identities = [];
  let clock = 100_000, store, file;
  const seat = { agent, alive: true, attention: reduceAttention(initialAttention(), { type: 'started' }) };
  if (agent === 'claude') {
    const folder = path.join(home, 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(folder, { recursive: true }); file = path.join(folder, id + '.jsonl');
    await writeFile(file, jsonl([user('question'), answer('old answer')]));
  } else {
    store = codexStore(home); store.thread(id, home, owner); store.turn(id, 'old', 'completed', 0, 'question', 'old answer');
  }
  const watcher = createTurnWatcher({ agent, cwd: home, nativeId: agent === 'claude' ? id : owner, now: () => clock,
    onIdentity: value => identities.push(value), onEvent: event => {
      events.push(event);
      const type = { 'watcher-state': 'watcher-state', completed: 'completed', 'turn-started': 'turn-started', 'turn-interrupted': 'interrupted' }[event.kind];
      if (type) seat.attention = reduceAttention(seat.attention, { ...event, type });
    } });
  seat.watcher = watcher;
  await watcher.refresh(); assert.equal(watcher.health().state, 'healthy');
  return { home, id, file, store, watcher, events, identities, seat, wake: () => { clock += overnight; },
    close() { watcher.stop(); store?.close(); if (before === undefined) delete process.env[env]; else process.env[env] = before; } };
}

for (const agent of ['claude', 'codex']) test(`${agent}: overnight recovery preserves identity, read versions and the exact outstanding answer`, async () => {
  const f = await fixture(agent);
  try {
    const { watcher, seat } = f;
    assert.equal(watcher.version(), 1);
    seat.attention = reduceAttention(seat.attention, { type: 'acknowledge', version: 1 });
    const request = await watcher.captureRequest('question');
    if (agent === 'claude') appendFileSync(f.file, jsonl([user('question')]));
    else f.store.turn(f.id, 'new', 'inProgress', 2, 'question', '');
    await watcher.refresh(); assert.equal(seat.attention.activity, 'working');
    f.wake();
    if (agent === 'claude') appendFileSync(f.file, jsonl([answer('new answer')]));
    else f.store.turn(f.id, 'new', 'completed', 2, 'question', 'new answer');
    assert.equal(watcher.health().state, 'pending');
    assert.match(watcher.health().error, /Rechecking native history/);
    assert.ok(readinessProblem(seat), 'delivery remains blocked until history is checked');
    assert.equal(watcher.version(), 1);
    const [, reply] = await Promise.all([watcher.refresh(), watcher.readResponse(request), watcher.refresh()]);
    assert.equal(reply.text, 'new answer'); assert.equal(watcher.health().state, 'healthy');
    assert.deepEqual(f.identities, [f.id]); assert.equal(watcher.version(), 2);
    assert.equal(seat.attention.readVersion, 1); assert.equal(seat.attention.completionVersion, 2); assert.equal(seat.attention.unread, true);
    assert.equal(readinessProblem(seat), null);
    seat.attention = reduceAttention(seat.attention, { type: 'acknowledge', version: 2 });
    f.wake(); assert.equal(watcher.health().state, 'pending'); await watcher.refresh();
    assert.equal(watcher.version(), 2); assert.equal(seat.attention.unread, false);
    assert.equal(f.events.filter(e => e.kind === 'completed').length, 2, 'no replay across repeated wake-ups');
    assert.ok(!f.events.some(e => e.state === 'error'));
  } finally { f.close(); }
});

for (const problem of ['invalid JSON', 'unsupported record', 'truncated', 'missing']) test(`wake recovery does not clear a real ${problem} fault`, async () => {
  const f = await fixture('claude');
  try {
    f.wake();
    if (problem === 'invalid JSON') appendFileSync(f.file, '{broken}\n');
    if (problem === 'unsupported record') appendFileSync(f.file, jsonl([{ type: 'future-unknown-format' }]));
    if (problem === 'truncated') writeFileSync(f.file, '');
    if (problem === 'missing') unlinkSync(f.file);
    assert.equal(f.watcher.health().state, 'pending'); await f.watcher.refresh();
    assert.equal(f.watcher.health().state, 'error');
    writeFileSync(f.file, jsonl([user('fixed'), answer('not a reason to silently reset tracking')]));
    await f.watcher.refresh(); assert.equal(f.watcher.health().state, 'error'); assert.equal(f.watcher.version(), 1);
  } finally { f.close(); }
});

test('stop during recovery cannot revive the watcher or emit a late completion', async () => {
  const f = await fixture('claude');
  try {
    f.wake(); assert.equal(f.watcher.health().state, 'pending'); f.watcher.stop();
    const count = f.events.length;
    appendFileSync(f.file, jsonl([user('later'), answer('later')])); await f.watcher.refresh();
    assert.equal(f.watcher.health().state, 'stopped'); assert.equal(f.events.length, count);
  } finally { f.close(); }
});

test('an incomplete JSONL write gets a wake grace period, but a continuously stalled write still faults', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-partial-wake-')), file = path.join(home, 'history.jsonl');
  let clock = 1000; const states = [], events = [];
  const record = JSON.stringify(user('split across sleep'));
  await writeFile(file, record.slice(0, 10));
  const stop = tailNativeFile(file, 'claude', e => events.push(e), 0, { interval: 60000, now: () => clock, onHealth: h => states.push(h) });
  try {
    await stop.flush(); clock += overnight; await stop.flush();
    assert.equal(states.at(-1).state, 'pending');
    appendFileSync(file, record.slice(10) + '\n'); await stop.flush();
    assert.equal(states.at(-1).state, 'healthy'); assert.equal(events.length, 1);
    appendFileSync(file, '{'); await stop.flush();
    for (let i = 0; i < 6; i++) { clock += 5000; await stop.flush(); }
    assert.equal(states.at(-1).state, 'error'); assert.match(states.at(-1).error, /incomplete record/);
  } finally { stop(); }
});
