// The station's session record (table-mode.md §3): one SQLite database in
// the user's home — never inside the repo a station is launched from — with
// a row per station run and an ordered event stream per station. Minutes are
// reconstructible from the events alone; the stations row carries the repo
// the chair convened in (root + remote) so runs can be queried by project.
// node:sqlite is built into Node >= 22.5, so this adds no dependency.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// node:sqlite announces itself as experimental on load, which would flash on
// every station launch; load it with the warning muted, nothing else.
const { DatabaseSync } = (() => {
  const emit = process.emitWarning;
  process.emitWarning = () => {};
  try { return createRequire(import.meta.url)('node:sqlite'); } finally { process.emitWarning = emit; }
})();

export const LEDGER_HOME = process.env.RELLIN_HOME || process.env.STATION_HOME
  ? path.resolve(process.env.RELLIN_HOME || process.env.STATION_HOME) : path.join(os.homedir(), '.mrmak');

// Recording health belongs to the run, not to an agent's native activity.
export function recordingWarning(health) {
  const messages = [];
  for (const target of ['ledger', 'mirror']) {
    const issue = health?.[target];
    if (!issue?.failedWrites) continue;
    messages.push(`${target === 'ledger' ? 'Record' : 'JSONL mirror'} incomplete: ${issue.failedWrites} failed write(s) · ${issue.failing ? 'write failed' : 'writes recovered'} · ${issue.lastEvent}: ${issue.lastError}`);
  }
  return messages.join(' | ').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

export function recordingIssueLabel(issues = []) {
  if (issues.some(issue => issue.gaps?.ledger)) return 'record incomplete';
  return issues.length ? 'JSONL mirror incomplete' : '';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  cwd TEXT NOT NULL,
  repo_root TEXT,
  repo_remote TEXT,
  seats TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  station_id TEXT NOT NULL REFERENCES stations(id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (station_id, seq)
);
CREATE TABLE IF NOT EXISTS station_runs (
  station_id TEXT PRIMARY KEY REFERENCES stations(id),
  name TEXT NOT NULL,
  pid INTEGER NOT NULL,
  ended_at TEXT,
  resumed_from TEXT
);
`;

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

// The repo the station was started in, if any: git's answer, not a guess.
export function repoInfo(cwd) {
  const git = args => new Promise(resolve => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
  });
  return Promise.all([git(['rev-parse', '--show-toplevel']), git(['config', '--get', 'remote.origin.url'])])
    .then(([root, remote]) => ({ root, remote }));
}

// openLedger({ cwd, seats, dir?, mirror? }) → { id, file, record(event), close() }
// record() stamps `at` and appends to the station's event stream; `mirror`
// (the --ledger override) additionally appends each event as JSONL for easy
// eyeballing. Writes are synchronous — the event rate is a conversation's.
export async function openLedger({ cwd, seats, dir = LEDGER_HOME, mirror = null, repo = null, name, resumedFrom = null, onRecordingHealth = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'station.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const id = randomUUID();
  const { root, remote } = repo ?? await repoInfo(cwd);
  // Claim conversations atomically, including resumes of an older ancestor run.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (resumedFrom) {
      const active = db.prepare('SELECT s.seats, r.pid FROM stations s JOIN station_runs r ON s.id = r.station_id WHERE r.ended_at IS NULL').all();
      if (active.some(row => processAlive(row.pid) && JSON.parse(row.seats).some(old => seats.some(seat => seat.nativeId && seat.agent === old.agent && seat.nativeId === old.nativeId)))) {
        throw new Error('One of these conversations is still open in another Rellin run. Close that run before resuming.');
      }
    }
    db.prepare('INSERT INTO stations (id, started_at, cwd, repo_root, repo_remote, seats) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, new Date().toISOString(), cwd, root, remote, JSON.stringify(seats));
    db.prepare('INSERT INTO station_runs (station_id, name, pid, resumed_from) VALUES (?, ?, ?, ?)')
      .run(id, name || path.basename(cwd) || 'Rellin', process.pid, resumedFrom);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const insert = db.prepare('INSERT INTO events (station_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)');
  if (mirror) mkdirSync(path.dirname(path.resolve(mirror)), { recursive: true });
  let seq = 0;
  let activitySeq = 0;
  const activityCache = new Map();
  const health = {};
  let pendingGaps = {};
  const notifyHealth = () => onRecordingHealth(structuredClone(health));
  const failed = (target, type, error) => {
    const at = new Date().toISOString();
    const lastError = String(error?.message || error);
    health[target] = { failedWrites: (health[target]?.failedWrites || 0) + 1, failing: true, lastEvent: type, lastError };
    const gap = pendingGaps[target] ||= { count: 0, firstAt: at, lastAt: at, lastEvent: type, lastError };
    Object.assign(gap, { count: gap.count + 1, lastAt: at, lastEvent: type, lastError });
    notifyHealth();
  };
  const recovered = target => {
    if (!health[target]?.failing) return;
    health[target].failing = false;
    notifyHealth(); // Keep the missing-write count: recovery cannot restore history.
  };
  const mirrorEvent = event => {
    if (!mirror) return;
    try { appendFileSync(path.resolve(mirror), JSON.stringify(event) + '\n'); }
    catch (error) { failed('mirror', event.type, error); return; }
    recovered('mirror');
  };
  const flushGaps = () => {
    if (!Object.keys(pendingGaps).length) return;
    const at = new Date().toISOString(), gaps = pendingGaps;
    // Do not recurse through record(), or claim the lost events were replayed.
    insert.run(id, seq + 1, at, 'recording-gap', JSON.stringify({ gaps }));
    seq++;
    pendingGaps = {};
    mirrorEvent({ at, type: 'recording-gap', gaps });
  };
  return {
    id,
    file,
    get recordingHealth() { return structuredClone(health); },
    activitySeries(since) {
      // One seed before the window per seat, then its transitions within it.
      // This is operational evidence from this run, never a restored heartbeat.
      const rows = db.prepare(`SELECT seq, at, payload FROM events WHERE station_id = ? AND seq > ? AND type = 'seat-attention' ORDER BY seq`).all(id, activitySeq);
      for (const row of rows) {
        const { seat, snapshot } = JSON.parse(row.payload), at = Date.parse(row.at);
        const series = activityCache.get(seat) || [];
        series.push({ at, snapshot });
        activityCache.set(seat, series);
        activitySeq = row.seq;
      }
      for (const series of activityCache.values()) {
        let cut = 0;
        while (cut + 1 < series.length && series[cut + 1].at < since) cut++;
        if (cut) series.splice(0, cut);
      }
      return new Map([...activityCache].map(([seat, series]) => [seat, structuredClone(series)]));
    },
    changeSeats(next, event) {
      if (!Array.isArray(next) || next.length < 1 || next.length > 4) throw new Error('Rellin needs one to four seats.');
      const at = new Date().toISOString(), { type, ...payload } = event;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE stations SET seats = ? WHERE id = ?').run(JSON.stringify(next), id);
        insert.run(id, seq + 1, at, type, JSON.stringify(payload));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      seats = next; seq++;
      mirrorEvent({ at, ...event });
    },
    removeSeat(index) {
      if (seats.length <= 1) throw new Error('Keep one seat open. Add another first, or quit Rellin.');
      const original = seats[index];
      if (!original) throw new Error('Unknown seat.');
      const archiveId = randomUUID(), at = new Date().toISOString();
      const name = db.prepare('SELECT name FROM station_runs WHERE station_id = ?').get(id).name;
      const archived = { ...original, closedFrom: id };
      const next = seats.filter((_, i) => i !== index), event = { seat: original.seat, archiveId };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO stations (id, started_at, cwd, repo_root, repo_remote, seats) VALUES (?, ?, ?, ?, ?, ?)')
          .run(archiveId, at, cwd, root, remote, JSON.stringify([archived]));
        db.prepare('INSERT INTO station_runs (station_id, name, pid, ended_at) VALUES (?, ?, ?, ?)')
          .run(archiveId, `${name} · ${original.seat} closed`, process.pid, at);
        db.prepare('UPDATE stations SET seats = ? WHERE id = ?').run(JSON.stringify(next), id);
        insert.run(id, seq + 1, at, 'seat-closed', JSON.stringify(event));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      seats = next; seq++;
      mirrorEvent({ at, type: 'seat-closed', ...event });
      return archiveId;
    },
    continueSeat(index, replacement, job) {
      const original = seats[index];
      if (!original || original.nativeId !== job.sourceNativeId) throw new Error('The source conversation changed before handoff.');
      const archiveId = randomUUID(), at = new Date().toISOString();
      const link = { handoffId: job.id, file: job.file, sourceArchiveId: archiveId, destinationStationId: id, destinationSeat: replacement.seat };
      const originalCopy = { ...original, handoffTo: link, attention: original.attention ? { ...original.attention, lifecycle: 'stopped' } : undefined };
      const next = seats.map((seat, i) => i === index ? { ...replacement, handoffFrom: link } : seat);
      const run = db.prepare('SELECT s.*, r.name FROM stations s JOIN station_runs r ON r.station_id = s.id WHERE s.id = ?').get(id);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO stations (id, started_at, cwd, repo_root, repo_remote, seats) VALUES (?, ?, ?, ?, ?, ?)')
          .run(archiveId, at, cwd, run.repo_root, run.repo_remote, JSON.stringify([originalCopy]));
        db.prepare('INSERT INTO station_runs (station_id, name, pid, ended_at) VALUES (?, ?, ?, ?)')
          .run(archiveId, `${run.name} · ${original.seat} before handoff`, process.pid, at);
        db.prepare('UPDATE stations SET seats = ? WHERE id = ?').run(JSON.stringify(next), id);
        insert.run(id, seq + 1, at, 'seat-handoff', JSON.stringify(link));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      seq += 1; seats = next;
      mirrorEvent({ at, type: 'seat-handoff', ...link });
      return link;
    },
    updateSeat(index, patch) {
      if (!seats[index]) throw new Error('Unknown seat.');
      seats[index] = { ...seats[index], ...patch };
      db.prepare('UPDATE stations SET seats = ? WHERE id = ?').run(JSON.stringify(seats), id);
    },
    attention(index, snapshot, cause) {
      if (!seats[index]) throw new Error('Unknown seat.');
      const next = seats.map((seat, i) => i === index ? { ...seat, attention: snapshot } : seat);
      const event = { seat: seats[index].seat, cause, snapshot };
      const at = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE stations SET seats = ? WHERE id = ?').run(JSON.stringify(next), id);
        insert.run(id, seq + 1, at, 'seat-attention', JSON.stringify(event));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      seq += 1;
      seats = next;
      mirrorEvent({ at, type: 'seat-attention', ...event });
    },
    record(event) {
      const { type, ...payload } = event;
      const at = new Date().toISOString();
      let written = false;
      try {
        flushGaps();
        insert.run(id, seq + 1, at, type, JSON.stringify(payload));
        seq++;
        written = true;
      } catch (error) { failed('ledger', type, error); }
      if (written) recovered('ledger');
      mirrorEvent({ at, ...event });
      return written;
    },
    close() {
      try {
        flushGaps();
        db.prepare('UPDATE station_runs SET ended_at = ? WHERE station_id = ?').run(new Date().toISOString(), id);
        recovered('ledger');
      } catch (error) { failed('ledger', 'close', error); throw error; }
      finally { db.close(); }
    },
  };
}

// The read side, for minutes and cross-run queries ("every table convened in
// repo X"). Returns plain objects with seats/payload parsed back to values.
export function readLedger(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const hasRuns = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'station_runs'").get();
  const hasEvents = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  return {
    history: () => db.prepare(hasRuns
      ? 'SELECT s.*, r.name, r.pid, r.ended_at, r.resumed_from FROM stations s LEFT JOIN station_runs r ON s.id = r.station_id ORDER BY s.started_at DESC, s.rowid DESC'
      : 'SELECT * FROM stations ORDER BY started_at DESC, rowid DESC').all()
      .map(row => ({ ...row, seats: JSON.parse(row.seats), active: !!row.pid && !row.ended_at && processAlive(row.pid),
        recordingIssues: hasEvents ? db.prepare("SELECT payload FROM events WHERE station_id = ? AND type = 'recording-gap' ORDER BY seq").all(row.id).map(event => JSON.parse(event.payload)) : [] })),
    stations: () => db.prepare('SELECT * FROM stations ORDER BY started_at').all()
      .map(row => ({ ...row, seats: JSON.parse(row.seats) })),
    events: stationId => db.prepare('SELECT * FROM events WHERE station_id = ? ORDER BY seq').all(stationId)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) })),
    close: () => { try { db.close(); } catch { } },
  };
}
