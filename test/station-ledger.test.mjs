import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLedger, readLedger, repoInfo } from '../station-ledger.mjs';

const SEATS = [
  { seat: 'claude', agent: 'claude', model: 'opus', effort: 'high', bypass: false },
  { seat: 'codex', agent: 'codex', model: 'default', effort: 'default', bypass: true },
];

test('a station run lands as one stations row plus an ordered event stream', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-ledger-'));
  const ledger = await openLedger({ cwd: 'C:/somewhere/repo', seats: SEATS, dir, repo: { root: 'C:/somewhere/repo', remote: 'git@github.com:x/repo.git' } });
  ledger.record({ type: 'table-started', topic: 'sqlite?' });
  ledger.record({ type: 'table-answer', seat: 'codex', text: 'yes', elapsedMs: 1200 });
  ledger.close();

  const read = readLedger(path.join(dir, 'station.db'));
  const stations = read.stations();
  assert.equal(stations.length, 1);
  assert.equal(stations[0].id, ledger.id);
  assert.equal(stations[0].repo_root, 'C:/somewhere/repo');
  assert.equal(stations[0].repo_remote, 'git@github.com:x/repo.git');
  assert.deepEqual(stations[0].seats, SEATS);
  const events = read.events(ledger.id);
  assert.deepEqual(events.map(event => [event.seq, event.type]), [[1, 'table-started'], [2, 'table-answer']]);
  assert.deepEqual(events[1].payload, { seat: 'codex', text: 'yes', elapsedMs: 1200 });
  assert.ok(events[0].at);
  read.close();
});

test('two runs share the database; each keeps its own stream', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-ledger-'));
  const repo = { root: null, remote: null };
  const first = await openLedger({ cwd: 'C:/a', seats: SEATS, dir, repo });
  first.record({ type: 'chair', to: 'all', text: 'hello' });
  first.close();
  const second = await openLedger({ cwd: 'C:/b', seats: SEATS.slice(0, 1).concat(SEATS[0]), dir, repo });
  second.record({ type: 'table-ended', reason: 'chair' });
  second.close();

  const read = readLedger(path.join(dir, 'station.db'));
  assert.equal(read.stations().length, 2);
  assert.equal(read.events(first.id).length, 1);
  assert.equal(read.events(second.id)[0].type, 'table-ended');
  assert.equal(read.stations()[0].repo_root, null);
  read.close();
});

test('a --ledger mirror file carries the same events as JSONL', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-ledger-'));
  const mirror = path.join(dir, 'mirror.jsonl');
  const ledger = await openLedger({ cwd: 'C:/a', seats: SEATS, dir, mirror, repo: { root: null, remote: null } });
  ledger.record({ type: 'table-prompt', seat: 'claude', round: 1, text: 'go' });
  ledger.close();
  const lines = (await readFile(mirror, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'table-prompt');
  assert.equal(lines[0].round, 1);
  assert.ok(lines[0].at);
});

test('repoInfo answers with the enclosing repo, or nulls outside one', async () => {
  const inside = await repoInfo(path.resolve(import.meta.dirname, '..'));
  assert.ok(inside.root && inside.root.toLowerCase().includes('station'));
  const outside = await repoInfo(os.tmpdir());
  assert.equal(outside.root, null);
});

