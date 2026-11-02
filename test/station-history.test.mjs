import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openLedger } from '../station-ledger.mjs';
import { formatHistory, loadHistory, parseOptions, prepareResume, selectRun } from '../station-history.mjs';
import { createTurnWatcher } from '../station-turns.mjs';

const repo = { root: null, remote: null };
const config = () => ({ seat: 'claude', agent: 'claude', model: 'opus', effort: 'high', bypass: false, nativeId: randomUUID() });

test('history and help are independent commands; conflicting or incomplete flags fail', () => {
  assert.deepEqual(parseOptions(['--history', '--dir', '.']), { history: true, dir: '.' });
  assert.deepEqual(parseOptions(['--resume', 'latest', '--name', 'Continue']), { resume: 'latest', name: 'Continue' });
  assert.throws(() => parseOptions(['--resume']), /Missing value/);
  assert.throws(() => parseOptions(['--name', '--history']), /Missing value/);
  assert.throws(() => parseOptions(['--resume', 'latest', '--seats', 'claude']), /not both/);
  assert.throws(() => parseOptions(['--history', '--name', 'x']), /only --dir/);
  assert.throws(() => parseOptions(['--name', '\x1b[2J']), /control characters/);
});

test('named runs retain native identities and permissions across reopen; active resumes are blocked', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-history-'));
  assert.deepEqual(loadHistory({ dir }), []);
  const seat = config();
  const run = await openLedger({ dir, cwd: dir, seats: [seat], name: 'First task', repo });
  const replacementId = randomUUID();
  run.updateSeat(0, { nativeId: replacementId });
  let saved = loadHistory({ dir })[0];
  assert.equal(saved.active, true);
  assert.equal(saved.seats[0].nativeId, replacementId);
  await assert.rejects(openLedger({ dir, cwd: dir, seats: saved.seats, resumedFrom: run.id, repo }), /still open/);
  await assert.rejects(prepareResume(saved), /still active/);
  run.close();
  saved = loadHistory({ dir })[0];
  assert.equal(saved.active, false);
  assert.equal(saved.name, 'First task');
  assert.equal(saved.seats[0].bypass, false);
  assert.equal(saved.seats[0].model, 'opus');
  assert.equal(saved.seats[0].effort, 'high');
  assert.equal(selectRun([saved], saved.id.slice(0, 8)).id, run.id);
  const next = await openLedger({ dir, cwd: dir, seats: saved.seats, name: saved.name, resumedFrom: run.id, repo });
  try {
    assert.equal(loadHistory({ dir })[0].resumed_from, run.id);
    // The original run is closed, but its conversations are now owned by next.
    await assert.rejects(openLedger({ dir, cwd: dir, seats: saved.seats, resumedFrom: run.id, repo }), /still open/);
    assert.equal(loadHistory({ dir }).length, 2, 'failed claims leave no phantom run');
  } finally { next.close(); }
});

test('history handles legacy rows, folder filters, ambiguous IDs and terminal control characters', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-legacy-'));
  // An actual pre-feature database, with no station_runs table.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'station.db'));
  db.exec('CREATE TABLE stations (id TEXT, started_at TEXT, cwd TEXT, seats TEXT)');
  db.prepare('INSERT INTO stations VALUES (?, ?, ?, ?)').run('abc123', '2026-01-01', dir, JSON.stringify([{ agent: 'claude' }]));
  db.close();
  const rows = loadHistory({ dir });
  assert.equal(rows.length, 1);
  assert.deepEqual(loadHistory({ dir, cwd: path.join(dir, 'elsewhere') }), []);
  assert.match(formatHistory(rows), /legacy/);
  assert.doesNotMatch(formatHistory([{ ...rows[0], name: 'bad\x1b[2J' }]), /\x1b/);
  assert.equal(selectRun(rows, 'latest').id, 'abc123');
  assert.throws(() => selectRun([...rows, { id: 'abc999' }], 'abc'), /several/);
  await assert.rejects(prepareResume(rows[0]), /no supported native/);
});

test('resume captures native transcript boundaries and never substitutes missing history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-native-'));
  const oldHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const seat = config();
  const folder = path.join(dir, 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `${seat.nativeId}.jsonl`);
  const record = id => JSON.stringify({ type: 'assistant', message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text: id }] } }) + '\n';
  await writeFile(file, record('old'));
  let watcher;
  try {
    const [restored] = await prepareResume({ cwd: dir, seats: [seat] });
    assert.equal(restored.resumeId, seat.nativeId);
    assert.equal(restored.mode, 'manual');
    assert.equal(restored.boundary.offset, Buffer.byteLength(record('old')));
    const events = [], identities = [];
    watcher = createTurnWatcher({ agent: 'claude', cwd: dir, nativeId: randomUUID(), resumeId: restored.resumeId, boundary: restored.boundary, onEvent: event => events.push(event), onIdentity: id => identities.push(id) });
    await delay(500);
    assert.deepEqual(events.filter(event => event.kind !== 'watcher-state'), [], 'historic answers are not new completions');
    await appendFile(file, record('new'));
    for (let i = 0; i < 20 && !events.some(event => event.kind === 'completed'); i++) await delay(100);
    assert.equal(events.filter(event => event.kind === 'completed').length, 1);
    assert.equal(events.find(event => event.kind === 'completed').id, 'new');
    assert.deepEqual(identities, [seat.nativeId]);
    assert.equal(await watcher.readFinal(), 'new');
    await assert.rejects(prepareResume({ cwd: dir, seats: [{ ...seat, nativeId: randomUUID() }] }), /history.*missing/);
  } finally {
    watcher?.stop();
    if (oldHome === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldHome;
  }
});

test('resumed Codex watches the exact saved thread, independent of its previous launch marker', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-codex-'));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  const seat = { ...config(), agent: 'codex', seat: 'codex' };
  const folder = path.join(dir, 'sessions', '2026', '01', '01');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `rollout-2026-01-01T00-00-00-${seat.nativeId}.jsonl`);
  const completed = id => JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: id } }) + '\n';
  await writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: seat.nativeId, cwd: dir, source: 'cli', originator: 'previous-launch' } }) + '\n' + completed('old'));
  let watcher;
  try {
    const [restored] = await prepareResume({ cwd: dir, seats: [seat] });
    const events = [], identities = [];
    watcher = createTurnWatcher({ agent: 'codex', cwd: dir, nativeId: randomUUID(), resumeId: restored.resumeId, boundary: restored.boundary, onEvent: event => events.push(event), onIdentity: id => identities.push(id) });
    await delay(500);
    assert.deepEqual(events.filter(event => event.kind !== 'watcher-state'), []);
    await appendFile(file, completed('new'));
    for (let i = 0; i < 20 && !events.some(event => event.kind === 'completed'); i++) await delay(100);
    assert.equal(events.find(event => event.kind === 'completed')?.id, 'new');
    assert.deepEqual(identities, [seat.nativeId]);
  } finally {
    watcher?.stop();
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  }
});
