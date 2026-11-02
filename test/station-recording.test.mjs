import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, readLedger, recordingWarning } from '../station-ledger.mjs';
import { formatHistory } from '../station-history.mjs';
import { renderStatus } from '../station.mjs';

async function fixture(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'station-recording-'));
  const changes = [];
  const ledger = await openLedger({ dir, cwd: dir, seats: [{ seat: 'codex', agent: 'codex' }],
    repo: { root: null, remote: null }, onRecordingHealth: health => changes.push(health), ...options });
  const db = new DatabaseSync(ledger.file);
  return { dir, ledger, db, changes };
}

test('failed event writes are visible, do not consume sequence numbers, and leave durable gap evidence after recovery', async () => {
  const { ledger, db, changes } = await fixture();
  try {
    db.exec("CREATE TRIGGER reject_match BEFORE INSERT ON events WHEN NEW.type = 'table-response-match' BEGIN SELECT RAISE(ABORT, 'test recording failure'); END");
    assert.equal(ledger.record({ type: 'table-started' }), true);
    assert.equal(ledger.record({ type: 'table-response-match', answerId: 'native-answer' }), false);
    assert.match(recordingWarning(ledger.recordingHealth), /Record incomplete.*write failed.*table-response-match.*test recording failure/);
    assert.equal(ledger.record({ type: 'table-response-match', answerId: 'another-answer' }), false);
    db.exec('DROP TRIGGER reject_match');
    assert.equal(ledger.record({ type: 'table-answer', text: 'native answer' }), true);
    ledger.record({ type: 'table-ended', reason: 'completed' });
    const health = ledger.recordingHealth;
    assert.equal(health.ledger.failedWrites, 2);
    assert.equal(health.ledger.failing, false);
    assert.match(recordingWarning(health), /incomplete.*writes recovered/);
    assert.equal(changes[0].ledger.failing, true, 'prior notifications are snapshots');
    const read = readLedger(ledger.file);
    try {
      const events = read.events(ledger.id);
      assert.deepEqual(events.map(e => [e.seq, e.type]), [[1, 'table-started'], [2, 'recording-gap'], [3, 'recording-gap'], [4, 'table-answer'], [5, 'table-ended']]);
      assert.equal(events.filter(e => e.type === 'recording-gap').reduce((sum, e) => sum + e.payload.gaps.ledger.count, 0), 2);
      assert.equal(events[1].payload.gaps.ledger.lastEvent, 'table-response-match');
      assert.match(formatHistory(read.history()), /record incomplete/);
      assert.equal(events.some(e => e.type === 'table-response-match'), false, 'no fabricated match or prompt replay');
    } finally { read.close(); }
  } finally { db.close(); ledger.close(); }
});

test('a real database lock keeps failures pending until the writer can persist the gap', async () => {
  const { ledger, db } = await fixture();
  try {
    db.exec('BEGIN IMMEDIATE');
    assert.equal(ledger.record({ type: 'chair', text: 'not recorded' }), false);
    assert.equal(ledger.record({ type: 'table-ended', reason: 'completed' }), false);
    assert.equal(ledger.recordingHealth.ledger.failedWrites, 2);
    db.exec('ROLLBACK');
    ledger.close(); // No later event needed to persist the missing final event.
    const read = readLedger(ledger.file);
    try {
      const events = read.events(ledger.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'recording-gap');
      assert.equal(events[0].payload.gaps.ledger.count, 2);
      assert.equal(events[0].payload.gaps.ledger.lastEvent, 'table-ended');
      assert.equal(read.history()[0].active, false);
    } finally { read.close(); }
  } finally { db.close(); }
});

test('a mirror failure does not claim the SQLite record failed, and stays visible after mirror recovery', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'station-mirror-'));
  const mirror = path.join(dir, 'mirror.jsonl');
  mkdirSync(mirror); // Deliberately unwritable as a file, without permission assumptions.
  const { ledger, db } = await fixture({ mirror });
  try {
    assert.equal(ledger.record({ type: 'table-answer', text: 'saved in SQLite' }), true);
    assert.equal(ledger.recordingHealth.ledger, undefined);
    assert.match(recordingWarning(ledger.recordingHealth), /^JSONL mirror incomplete/);
    rmdirSync(mirror);
    assert.equal(ledger.record({ type: 'table-ended', reason: 'completed' }), true);
    assert.equal(ledger.recordingHealth.mirror.failing, false);
    assert.match(recordingWarning(ledger.recordingHealth), /incomplete.*writes recovered/);
    const mirrored = readFileSync(mirror, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(mirrored.map(e => e.type), ['recording-gap', 'table-ended']);
    assert.equal(mirrored[0].gaps.mirror.count, 1);
  } finally { db.close(); ledger.close(); }
});

test('permanent write failure at close remains observable and is not reported as recovered', async () => {
  const { ledger, db } = await fixture();
  db.exec('BEGIN IMMEDIATE');
  try {
    ledger.record({ type: 'table-ended', reason: 'completed' });
    assert.throws(() => ledger.close(), /locked/);
    assert.equal(ledger.recordingHealth.ledger.failing, true);
    assert.match(recordingWarning(ledger.recordingHealth), /write failed/);
  } finally { db.exec('ROLLBACK'); db.close(); }
});

test('recording warning stays ahead of transient notices in Console and table, including narrow terminals', () => {
  const warning = recordingWarning({ ledger: { failedWrites: 1, failing: true, lastEvent: 'chair', lastError: 'bad\x1b[2J\nerror' } });
  assert.doesNotMatch(warning, /[\x00-\x1f\x7f-\x9f]/);
  for (const view of ['console', 'table']) {
    const state = { recordingWarning: warning, interactionNotice: 'Text pasted', view };
    const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal(plain(renderStatus(state, 300)), warning);
    assert.equal(plain(renderStatus(state, 20)), warning.slice(0, 20));
  }
});
