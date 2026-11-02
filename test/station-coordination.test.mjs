import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, mkdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { correlatedResponse, guardedDelivery, readinessProblem } from '../station-coordination.mjs';
import { createTurnWatcher } from '../station-turns.mjs';
import { tailNativeFile, nativeRecordProblem } from '../native-events.mjs';
import { initialAttention, reduceAttention } from '../station-attention.mjs';
import { codexStore } from './fixtures/codex-store.mjs';
import { renderTable } from '../station-table.mjs';

const user = text => ({ type: 'user', uuid: randomUUID(), message: { content: text } });
const answer = (text, extra = {}) => ({ type: 'assistant', message: { id: randomUUID(), stop_reason: 'end_turn', content: [{ type: 'text', text }] }, ...extra });
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const until = async predicate => { for (let i = 0; i < 50 && !predicate(); i++) await delay(40); assert.ok(predicate()); };
const readySeat = () => ({ alive: true, watcher: {}, attention: { lifecycle: 'running', activity: 'completed', watcher: { state: 'healthy', error: null } } });

test('a stopped JSONL poll cannot overwrite the health of its SQLite replacement', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-old-tail-'));
  const file = path.join(home, 'bootstrap.jsonl'), health = [];
  await writeFile(file, jsonl([{ type: 'session_meta', payload: { id: randomUUID() } }]));
  const stop = tailNativeFile(file, 'codex', () => {}, 0, { onHealth: value => health.push(value) });
  stop(); // The first asynchronous stat/read is still in flight.
  await delay(70);
  assert.deepEqual(health, [], 'retired poll must not emit pending, healthy or failure');
});

test('fresh Codex menu input cannot poison discovery before the first native request', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-codex-startup-')), before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const id = randomUUID(), owner = randomUUID(), events = [];
  const watcher = createTurnWatcher({ agent: 'codex', cwd: home, nativeId: owner, onEvent: event => events.push(event), progressTimeoutMs: 25 });
  let store;
  try {
    watcher.expectProgress({ manual: true });
    await delay(70);
    assert.equal(watcher.health().state, 'pending', 'no model request has been proved');
    store = codexStore(home); store.thread(id, home, owner);
    await until(() => watcher.health().state === 'healthy');
    watcher.expectProgress({ manual: true });
    await delay(70);
    assert.equal(watcher.health().state, 'healthy', 'empty native store is still not proof of a submitted turn');
    store.turn(id, 'first', 'inProgress', 0, 'real first request', '');
    await watcher.refresh();
    assert.ok(events.some(event => event.kind === 'turn-started'));
    store.turn(id, 'first', 'completed', 0, 'real first request', 'real answer');
    await watcher.refresh();
    assert.equal(watcher.version(), 1);
    assert.ok(!events.some(event => event.state === 'error'));
    watcher.expectProgress({ manual: true });
    await until(() => watcher.health().state === 'pending');
    assert.match(watcher.health().error, /No native turn/, 'missing progress remains visibly uncertain');
    await watcher.refresh();
    assert.equal(watcher.health().state,'pending','an ordinary healthy poll cannot clear missing progress');
    store.turn(id, 'late', 'completed', 2, 'late native request', 'late answer');
    await watcher.refresh();
    assert.equal(watcher.health().state,'healthy','native evidence can recover an observation delay');
    assert.equal(watcher.version(),2);
  } finally { watcher.stop(); store?.close(); if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; }
});

test('admission blocks busy, waiting, uncertain, broken, stopped and drafted seats', () => {
  assert.equal(readinessProblem(readySeat()), null);
  for (const activity of ['working', 'waiting', 'failed']) assert.ok(readinessProblem({ ...readySeat(), attention: { ...readySeat().attention, activity } }));
  for (const state of ['pending', 'error', 'stopped']) assert.ok(readinessProblem({ ...readySeat(), attention: { ...readySeat().attention, watcher: { state } } }));
  assert.ok(readinessProblem({ ...readySeat(), watcher: null }));
  assert.ok(readinessProblem({ ...readySeat(), alive: false }));
  assert.ok(readinessProblem({ ...readySeat(), draftDirty: true }));
  assert.ok(readinessProblem(readySeat(), { prompt: { id: 'approval' } }));
});

test('delivery checks before paste and again before Enter, including owner input and process replacement', async () => {
  for (const change of ['busy', 'approval', 'local-menu', 'input', 'process', 'tracking']) {
    const seat = readySeat(), writes = []; let current = true, menu = null;
    await assert.rejects(guardedDelivery({ seat, proc: { write: text => writes.push(text) }, text: 'prompt', current: () => current, prompt: () => menu,
      refresh: async () => {}, onSubmit: () => assert.fail('must not submit'), wait: async () => {
        if (change === 'busy') seat.attention.activity = 'working';
        if (change === 'approval') menu = {};
        if (change === 'local-menu') seat.localCommand = '/config';
        if (change === 'input') seat.inputVersion = 1;
        if (change === 'process') current = false;
        if (change === 'tracking') seat.attention.watcher.state = 'error';
      },
    }), /Enter was not sent/);
    assert.deepEqual(writes, ['\x1b[200~prompt\x1b[201~']); assert.equal(seat.draftDirty, true);
  }
  const writes = [], seat = readySeat(); seat.attention.activity = 'working';
  await assert.rejects(guardedDelivery({ seat, proc: { write: data => writes.push(data) }, current: () => true, prompt: () => null, text: 'prompt' }), /working/);
  assert.deepEqual(writes, []);
});

test('Claude correlation ignores unrelated completions, sidechains, tool results and newer owner turns', () => {
  const text = 'exact table prompt', request = { text };
  const records = [answer('OLD COMPLETION'), user(`<pasted_content id="one">\n${text}\n</pasted_content id="one">`), answer('SIDECHAIN', { isSidechain: true }),
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } }, answer('TABLE ANSWER'), user('owner asks another question'), answer('LATEST UNRELATED')];
  assert.equal(correlatedResponse(records, 'claude', request).text, 'TABLE ANSWER');
  assert.equal(correlatedResponse([answer('Unrelated only')], 'claude', request), null);
  assert.throws(() => correlatedResponse([user(text), user('new question'), answer('not the table answer')], 'claude', request), /superseded/);
  assert.throws(() => correlatedResponse([user(text), answer('a'), user(text), answer('b')], 'claude', request), /Ambiguous/);
  assert.equal(correlatedResponse([user(text), { ...answer('draft'), message: { ...answer('draft').message, stop_reason: 'tool_use' } }], 'claude', request), null);
});

test('Codex JSONL correlation requires native completion, not commentary or a different turn', () => {
  const event = payload => ({ type: 'event_msg', payload });
  const records = [event({ type: 'task_started', turn_id: 'table' }), event({ type: 'user_message', message: 'prompt' }),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prompt' }] } },
    event({ type: 'agent_message', message: 'draft' })];
  assert.equal(correlatedResponse(records, 'codex', { text: 'prompt' }), null);
  records.push(event({ type: 'task_complete', turn_id: 'wrong', last_agent_message: 'wrong answer' }));
  assert.equal(correlatedResponse(records, 'codex', { text: 'prompt' }), null);
  records.push(event({ type: 'task_complete', turn_id: 'table', last_agent_message: 'correct answer' }), event({ type: 'user_message', message: 'another question' }), event({ type: 'task_complete', last_agent_message: 'newest answer' }));
  assert.equal(correlatedResponse(records, 'codex', { text: 'prompt' }).text, 'correct answer');
  assert.equal(correlatedResponse([{ type: 'user', content: 'prompt' }, { type: 'assistant', content: 'Grok answer' }], 'grok', { text: 'prompt' }).text, 'Grok answer');
});

test('Claude session metadata is accepted without inventing readiness or completion', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-claude-metadata-'));
  const file = path.join(home, 'conversation.jsonl'), events = [], health = [];
  const metadata = [
    { type: 'mode', mode: 'normal', sessionId: 'fixture' },
    { type: 'permission-mode', permissionMode: 'default', sessionId: 'fixture' },
    { type: 'attachment', attachment: { type: 'context', content: 'fixture metadata' } },
    { type: 'ai-title', aiTitle: 'Status test', sessionId: 'fixture' },
      { type: 'file-history-delta', messageId: 'edit', snapshotMessageId: 'snapshot', trackingPath: 'scratch/check.mjs',
        backup: { backupFileName: null, version: 1, backupTime: '2026-10-30T21:35:02.548Z', realParentDir: 'scratch' }, timestamp: '2026-10-30T21:35:02.551Z' },
  ];
  await writeFile(file, jsonl(metadata));
  const stop = tailNativeFile(file, 'claude', event => events.push(event), 0, { interval: 15, onHealth: state => health.push(state) });
  try {
    await stop.flush();
    assert.equal(health.at(-1).state, 'pending');
    assert.deepEqual(events, [], 'metadata alone never establishes agent activity');
    await appendFile(file, jsonl([user('Status test'), ...metadata, answer('Status reply')]));
    await stop.flush();
    assert.equal(health.at(-1).state, 'healthy');
    assert.deepEqual(events.map(event => event.kind), ['turn-started', 'turn-completed']);
    await appendFile(file, '{"type":"permission-mode","permissionMode":{}}\n');
    await stop.flush();
    assert.equal(health.at(-1).state, 'error', 'unsupported shapes still fail loudly');
  } finally { stop(); }
});

test('Claude file-history deltas accept observed backup variants and reject malformed bookkeeping', () => {
  const delta = { type: 'file-history-delta', messageId: 'edit', snapshotMessageId: 'snapshot', trackingPath: 'scratch/check.mjs',
    backup: { backupFileName: null, version: 1, backupTime: '2026-10-30T21:35:02.548Z' }, timestamp: '2026-10-30T21:35:02.551Z' };
  assert.equal(nativeRecordProblem(delta, 'claude'), null);
  assert.equal(nativeRecordProblem({ ...delta, backup: { ...delta.backup, backupFileName: 'saved-backup', version: 2 } }, 'claude'), null);
  for (const patch of [{ trackingPath: null }, { snapshotMessageId: [] }, { backup: null }, { backup: [] }, { backup: { ...delta.backup, version: '1' } }, { backup: { ...delta.backup, backupFileName: {} } }]) {
    assert.match(nativeRecordProblem({ ...delta, ...patch }, 'claude'), /Unsupported Claude file-history-delta/);
  }
  assert.match(nativeRecordProblem({ type: 'new-unknown-record' }, 'claude'), /Unknown Claude record type/);
});

test('Codex world-state and token accounting metadata do not block first-turn tracking', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-codex-metadata-'));
  const file = path.join(home, 'rollout.jsonl'), events = [], health = [];
  const metadata = [
    { type: 'world_state', payload: { full: true, state: {} } },
    { type: 'token_usage_record', payload: { thread_id: 'fixture', turn_id: 'turn', usage: { input_tokens: 10, output_tokens: 2 } } },
  ];
  await writeFile(file, jsonl([{ type: 'session_meta', payload: { id: randomUUID() } }, ...metadata]));
  const stop = tailNativeFile(file, 'codex', event => events.push(event), 0, { interval: 15, onHealth: state => health.push(state) });
  try {
    await stop.flush(); assert.equal(health.at(-1).state, 'pending'); assert.deepEqual(events, []);
    await appendFile(file, jsonl([
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      ...metadata,
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'STATUS OK' } },
    ]));
    await stop.flush(); assert.equal(health.at(-1).state, 'healthy');
    assert.deepEqual(events.map(event => event.kind), ['turn-started', 'turn-completed']);
    await appendFile(file, '{"type":"future_unknown_turn","payload":{}}\n');
    await stop.flush(); assert.match(health.at(-1).error, /future_unknown_turn/);
  } finally { stop(); }
});

test('native JSONL faults are loud and latched; a partial append is pending, not malformed', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-watch-health-'));
  for (const failure of ['malformed', 'missing', 'schema', 'truncate']) {
    const file = path.join(home, failure + '.jsonl'), health = [];
    await writeFile(file, jsonl([user('hello'), answer('ready')]));
    const stop = tailNativeFile(file, 'claude', () => {}, 0, { interval: 15, onHealth: state => health.push(state) });
    try {
      await until(() => health.at(-1)?.state === 'healthy');
      if (failure === 'missing') await unlink(file);
      else if (failure === 'truncate') await writeFile(file, '');
      else await appendFile(file, failure === 'malformed' ? '{bad}\n' : '{"type":"assistant","new_content":"changed format"}\n');
      await until(() => health.at(-1)?.state === 'error');
      await writeFile(file, jsonl([user('hello'), answer('fixed')])); await delay(40);
      assert.equal(health.at(-1).state, 'error');
    } finally { stop(); }
  }
  const file = path.join(home, 'partial.jsonl'), health = [];
  await writeFile(file, jsonl([user('hello')]));
  const stop = tailNativeFile(file, 'claude', () => {}, 0, { interval: 15, onHealth: state => health.push(state) });
  try {
    await until(() => health.at(-1)?.state === 'healthy');
    const line = JSON.stringify(answer('complete later'));
    await appendFile(file, line.slice(0, 30)); await until(() => health.at(-1)?.state === 'pending');
    await appendFile(file, line.slice(30) + '\n'); await until(() => health.at(-1)?.state === 'healthy');
    assert.ok(!health.some(state => state.state === 'error'));
  } finally { stop(); }
});

test('JSONL checkpoints exclude old identical prompts; missing discovery remains uncertain until native evidence', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-request-position-')), before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  const id = randomUUID(), folder = path.join(home, 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true }); const file = path.join(folder, `${id}.jsonl`);
  await writeFile(file, jsonl([user('same prompt'), answer('OLD')]));
  const watcher = createTurnWatcher({ agent: 'claude', cwd: home, nativeId: id, onEvent: () => {} });
  const missing = createTurnWatcher({ agent: 'claude', cwd: home, nativeId: randomUUID(), onEvent: () => {}, progressTimeoutMs: 30 });
  try {
    await until(() => watcher.health().state === 'healthy');
    const request = await watcher.captureRequest('same prompt');
    assert.equal(await watcher.readResponse(request), null);
    await appendFile(file, jsonl([answer('unrelated'), user('same prompt'), answer('CORRECT'), user('later'), answer('LATEST')]));
    assert.equal((await watcher.readResponse(request)).text, 'CORRECT');
    missing.expectProgress(); await until(() => !!missing.health().error);
    assert.equal(missing.health().state,'pending');
    assert.match(missing.health().error,/will not be resent/);
  } finally { watcher.stop(); missing.stop(); if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; }
});

test('SQLite correlation uses the matching completed turn; schema/status failures block tracking', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-table-db-')), before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const store = codexStore(home), id = randomUUID(), owner = randomUUID();
  store.thread(id, home, owner); store.turn(id, 'old', 'completed', 0, 'prompt', 'OLD');
  const events = [], watcher = createTurnWatcher({ agent: 'codex', cwd: home, nativeId: owner, onEvent: event => events.push(event) });
  try {
    await until(() => watcher.health().state === 'healthy'); const request = await watcher.captureRequest('prompt');
    store.turn(id, 'target', 'inProgress', 2, 'prompt', 'streaming'); store.turn(id, 'other', 'completed', 4, 'other question', 'WRONG');
    assert.equal(await watcher.readResponse(request), null);
    store.turn(id, 'target', 'completed', 2, 'prompt', 'MATCHED');
    assert.equal((await watcher.readResponse(request)).text, 'MATCHED');
    store.turn(id, 'unsupported', 'new-status-format', 6); await watcher.refresh();
    assert.equal(watcher.health().state, 'error');
    assert.ok(events.some(event => event.kind === 'watcher-state' && event.state === 'error'));
  } finally { watcher.stop(); store.close(); if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; }
});

test('tracking failure preserves unread and cannot be cleared by a late completion; table labels launch posture honestly', () => {
  let attention = reduceAttention(initialAttention(), { type: 'started' });
  attention = reduceAttention(attention, { type: 'completed', id: 'answer' });
  attention = reduceAttention(attention, { type: 'watcher-state', state: 'error', error: 'broken source' });
  attention = reduceAttention(attention, { type: 'completed', id: 'late' });
  assert.equal(attention.watcher.state, 'error'); assert.equal(attention.unread, true);
  const seats = [{ seat: 'claude', alive: true, bypass: true, attention }, { seat: 'codex', alive: true, bypass: false }];
  const output = renderTable({ table: null, ui: { input: 'still typing', scroll: 0 }, seats, width: 100, height: 30, colorOf: () => '', notice: 'Cannot convene: broken source' });
  assert.match(output, /\x1b\[7mBYPASS\x1b\[27m/); assert.doesNotMatch(output, /manual/); assert.match(output, /asked, not enforced/); assert.match(output, /Cannot convene: broken source/);
});
