import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

// Minimal schemas from the installed Codex 0.166 databases, in isolated test homes.
export function codexStore(home) {
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec('PRAGMA busy_timeout = 5000');
  state.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT, source TEXT, originator TEXT, thread_source TEXT, history_mode TEXT, rollout_path TEXT, created_at INTEGER)`);
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec('PRAGMA busy_timeout = 5000');
  history.exec(`CREATE TABLE IF NOT EXISTS thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, rollout_ordinal INTEGER, PRIMARY KEY(thread_id,turn_id));
    CREATE TABLE IF NOT EXISTS thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, created_at_ms INTEGER, item_json TEXT, item_type TEXT, rollout_ordinal INTEGER)`);
  return {
    state, history,
    thread(id, cwd, owner, extra = {}) {
      state.prepare('INSERT OR REPLACE INTO threads VALUES (?,?,?,?,?,?,?,?)').run(id, cwd, extra.source || 'cli', `mrmak_chat_${owner}`, extra.threadSource || 'user', 'paginated', path.join(home, `rollout-${extra.stamp || '2026-10-30T00-00-00'}-${id}.jsonl`), Date.now());
    },
    turn(id, turn, status, ordinal, text = 'hello', reply = 'answer') {
      // Multiple fake seats share these files. Publish a turn and its items
      // together so a watcher cannot see a completed but half-written answer.
      history.exec('BEGIN IMMEDIATE');
      try {
        history.prepare('INSERT OR REPLACE INTO thread_turns VALUES (?,?,?,?)').run(id, turn, status, ordinal);
        history.prepare('DELETE FROM thread_items WHERE thread_id = ? AND turn_id = ?').run(id, turn);
        const insert = history.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?)');
        insert.run(id, turn, `${turn}-user`, Date.now(), JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text }] }), 'userMessage', ordinal);
        insert.run(id, turn, `${turn}-assistant`, Date.now(), JSON.stringify({ type: 'agentMessage', text: reply, phase: 'final_answer' }), 'agentMessage', ordinal + 1);
        history.exec('COMMIT');
      } catch (error) { history.exec('ROLLBACK'); throw error; }
    },
    close() { history.close(); state.close(); },
  };
}
