// Read-only adapter for Codex's paginated history (observed in CLI 0.166).
// Legacy JSONL discovery remains separate. Never migrate or write provider data.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const homeDir = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function query(file, sql, params = []) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

export function codexDbThreads({ home = homeDir(), id, originator } = {}) {
  try {
    const rows = query(path.join(home, 'state_5.sqlite'),
      'SELECT id, cwd, source, originator, thread_source, history_mode, rollout_path, created_at FROM threads WHERE ' + (id ? 'id = ?' : 'originator = ?'), [id || originator]);
    return rows.filter(row => uuid.test(row.id) && row.history_mode === 'paginated').map(row => ({
      id: row.id, cwd: row.cwd, source: row.source, originator: row.originator,
      threadSource: row.thread_source, file: row.rollout_path, storage: 'sqlite', createdAt: row.created_at,
    }));
  } catch { return []; } // Discovery remains uncertain until a supported source is found.
}

export function codexDbTurns(id, { home = homeDir() } = {}) {
  if (!uuid.test(id || '')) throw new Error('Invalid Codex conversation ID.');
  return query(path.join(home, 'thread_history_1.sqlite'),
    'SELECT turn_id, status, rollout_ordinal FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1000', [id]).reverse();
}

export function codexDbRecords(id, { home = homeDir(), maxBytes = 4 * 1024 * 1024, strict = false } = {}) {
  if (!uuid.test(id || '')) throw new Error('Invalid Codex conversation ID.');
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'), { readOnly: true });
  const records = [];
  let size = 0, limited = false;
  try {
    const rows = db.prepare('SELECT i.item_id, i.created_at_ms, i.item_json, i.turn_id, t.status FROM thread_items i LEFT JOIN thread_turns t ON t.thread_id = i.thread_id AND t.turn_id = i.turn_id WHERE i.thread_id = ? AND i.item_type IN (?, ?) ORDER BY i.rollout_ordinal DESC LIMIT 1001')
      .iterate(id, 'userMessage', 'agentMessage');
    for (const row of rows) {
      size += Buffer.byteLength(row.item_json);
      if (size > maxBytes || records.length >= 1000) { limited = true; break; }
      let item;
      try { item = JSON.parse(row.item_json); } catch { if (strict) throw new Error('Codex native history contains invalid JSON.'); limited = true; continue; }
      if (strict && (!['userMessage', 'agentMessage'].includes(item?.type) || !['inProgress', 'completed', 'interrupted', 'failed'].includes(row.status))) throw new Error('Unsupported Codex native history format.');
      const user = item.type === 'userMessage';
      if (strict && (user ? !Array.isArray(item.content) : typeof item.text !== 'string')) throw new Error('Unsupported Codex message content.');
      const text = user ? (item.content || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n') : item.text;
      records.push({ type: 'response_item', uuid: row.item_id, nativeTurnId: row.turn_id, nativeStatus: row.status, timestamp: new Date(row.created_at_ms).toISOString(), payload: { type: 'message', phase: item.phase, role: user ? 'user' : 'assistant', content: [{ type: 'text', text: text || '' }] } });
    }
  } finally { db.close(); }
  return { records: records.reverse(), limited };
}

// Turn statuses, not terminal silence or streaming text, define completion.
export function tailCodexDb(id, onEvent, { boundary = [], home = homeDir(), interval = 400, onHealth = null } = {}) {
  const seen = new Map(boundary.map(turn => [turn.turn_id, turn.status]));
  let closed = false, failed = false, busyRetries = 0;
  let lastOrdinal = Math.max(-1, ...boundary.map(turn => turn.rollout_ordinal));
  const poll = () => {
    if (closed || failed) return;
    let turns;
    try {
      turns = codexDbTurns(id, { home });
      if (onHealth) {
        const newest = Math.max(-1, ...turns.map(turn => turn.rollout_ordinal));
        if (newest < lastOrdinal) throw new Error('Codex tracked turns disappeared or rewound.');
        lastOrdinal = newest;
        if (turns.some(turn => !['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status))) throw new Error('Unknown Codex turn status.');
        codexDbRecords(id, { home, strict: true });
      }
      busyRetries = 0;
    } catch (error) {
      if (/locked|busy/i.test(error.message) && ++busyRetries < 3) { onHealth?.({ state: 'pending', error: null }); return; }
      failed = !!onHealth; onHealth?.({ state: 'error', error: `Codex tracking failed: ${error.message}` }); return;
    }
    for (const turn of turns) {
      if (seen.get(turn.turn_id) === turn.status) continue;
      seen.set(turn.turn_id, turn.status);
      const kind = { completed: 'turn-completed', inProgress: 'turn-started', interrupted: 'turn-interrupted', failed: 'attention' }[turn.status];
      if (kind) onEvent({ kind, id: turn.turn_id, ...(kind === 'attention' ? { text: 'Codex reported a failed turn.' } : {}) });
    }
    onHealth?.({ state: 'healthy', error: null });
  };
  const timer = setInterval(poll, interval); timer.unref?.();
  // Defer the first callback so callers can finish binding the watcher.
  queueMicrotask(poll);
  const stop = () => { closed = true; clearInterval(timer); };
  stop.flush = async () => poll();
  return stop;
}
