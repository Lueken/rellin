import { open, stat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { grokText, grokSynthetic, grokFinal, grokRecordProblem } from './grok-records.mjs';

export function completedTurn(record, agent) {
  // Grok writes one flat assistant record per finished reply, complete text
  // in `content`; there is no separate completion event.
  if (agent === 'grok') {
    if (!grokFinal(record)) return;
    return { kind: 'turn-completed', id: record.id || null, text: 'The agent finished its turn. Review the result.', preview: grokText(record).slice(-350) };
  }
  if (agent === 'codex' && record.type === 'event_msg' && record.payload?.type === 'task_complete') return { kind: 'turn-completed', id: record.payload.turn_id, text: 'The agent finished its turn. Review the result.', preview: String(record.payload.last_agent_message || '').slice(-350) };
  // Claude writes thinking and text as separate records with the same message ID
  // and stop reason. Only the actual final answer creates a completion notice.
  if (agent === 'claude' && !record.isSidechain && record.type === 'assistant' && record.message?.stop_reason === 'end_turn' && record.message.content?.some(item => item.type === 'text')) return { kind: 'turn-completed', id: record.message.id, text: 'The agent finished its turn. Review the result.', preview: record.message.content.filter(item => item.type === 'text').map(item => item.text).join('\n').slice(-350) };
  if (agent === 'claude' && !record.isSidechain && record.type === 'system' && record.subtype === 'api_error') return { kind: 'attention', text: 'The agent reported an API error.', providerCode: record.error?.status ?? record.error?.code ?? record.statusCode ?? record.error?.type ?? null };
  return null;
}

export function nativeActivity(record, agent) {
  const completed = completedTurn(record, agent);
  if (completed) return completed;
  if (agent === 'codex' && record.type === 'event_msg') {
    if (record.payload?.type === 'task_started') return { kind: 'turn-started' };
    if (record.payload?.type === 'turn_aborted') return { kind: 'turn-interrupted' };
  }
  if (agent === 'grok' && !grokSynthetic(record) && (record.type === 'user' || record.type==='assistant' && record.tool_calls?.length)) return { kind: 'turn-started' };
  if (agent === 'claude' && !record.isSidechain) {
    if (record.type === 'user' && !record.isMeta) {
      const content = record.message?.content;
      const interrupted = value => typeof value === 'string' && value.startsWith('[Request interrupted by user');
      if (interrupted(content) || Array.isArray(content) && content.some(item => item.type === 'text' && interrupted(item.text))) return { kind: 'turn-interrupted' };
      // Tool results also confirm ongoing work; file snapshots and metadata do not.
      if (content) return { kind: 'turn-started' };
    }
    if (record.type === 'assistant' && record.message?.stop_reason !== 'end_turn') return { kind: 'turn-started' };
  }
  return null;
}

// Only read records appended after this managed session starts. These files belong
// to the native CLI; SADDLEPOINT never modifies them or replaces the user's hooks.
export function nativeRecordProblem(record, agent) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') return 'Unrecognized native record shape';
  if (agent === 'claude') {
    // Claude 2.1.227 writes these session/attachment metadata records around
    // ordinary turns. They are not turn activity or readiness evidence.
    const metadataField = { mode: 'mode', 'permission-mode': 'permissionMode', 'ai-title': 'aiTitle' }[record.type];
    if (metadataField) return typeof record[metadataField] === 'string' ? null : `Unsupported Claude ${record.type} metadata`;
    if (record.type === 'attachment') return record.attachment && typeof record.attachment === 'object' && !Array.isArray(record.attachment)
      ? null : 'Unsupported Claude attachment metadata';
    if (record.type === 'file-history-delta') {
      // Observed when Claude edits a scratch file: this updates its rewind
      // bookkeeping, not model activity. Never open the referenced paths.
      const backup = record.backup;
      const valid = ['messageId', 'snapshotMessageId', 'trackingPath', 'timestamp'].every(key => typeof record[key] === 'string' && record[key].length > 0)
        && backup && typeof backup === 'object' && !Array.isArray(backup)
        && (backup.backupFileName === null || typeof backup.backupFileName === 'string')
        && Number.isSafeInteger(backup.version) && backup.version >= 0
        && typeof backup.backupTime === 'string'
        && (backup.realParentDir === undefined || typeof backup.realParentDir === 'string');
      return valid ? null : 'Unsupported Claude file-history-delta metadata';
    }
    if (['user', 'assistant'].includes(record.type)) {
      if (!record.message || !(typeof record.message.content === 'string' || Array.isArray(record.message.content))) return 'Unsupported Claude message format';
      return null;
    }
    if (!['system', 'progress', 'file-history-snapshot', 'queue-operation', 'summary', 'custom-title', 'tag', 'pr-link', 'agent-name', 'last-prompt', 'branch-summary', 'saved_hook_context'].includes(record.type)) return `Unknown Claude record type: ${record.type}`;
  } else if (agent === 'codex') {
    // 0.166 JSONL includes context snapshots and accounting alongside native
    // turn events, even when paginated SQLite history is also being written.
    if (!['session_meta', 'turn_context', 'event_msg', 'response_item', 'compacted', 'world_state', 'token_usage_record'].includes(record.type)
      || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) return `Unsupported Codex record format: ${record.type}`;
    if (['event_msg', 'response_item'].includes(record.type) && typeof record.payload.type !== 'string') return 'Unsupported Codex event format';
    if (record.type === 'event_msg' && /^(task_|turn_|user_|agent_|item_)/.test(record.payload.type)
      && !['task_started', 'task_complete', 'turn_aborted', 'user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'agent_reasoning_section_break', 'item_started', 'item_completed'].includes(record.payload.type)) return `Unknown Codex activity event: ${record.payload.type}`;
  } else if (agent === 'grok') {
    return grokRecordProblem(record);
  }
  return null;
}

export function tailNativeFile(file, agent, onEvent, from = 0, { onHealth = null, onRecord = null, interval = 400, partialTimeoutMs = 30000, staleMs = 10000, now = Date.now } = {}) {
  let offset = from, partial = '', closed = false, reading = false, decoder = new StringDecoder('utf8');
  let existed = from > 0, understood = from > 0, failed = false, partialSince = null;
  let lastPoll = now();
  const health = (state, error = null) => { if (closed) return; if (state === 'error') failed = true; onHealth?.({ state, error }); };
  const tick = async () => {
    if (closed || reading || failed) return;
    const at = now();
    // A sleeping producer cannot finish a partial line. Give it the normal
    // grace period on wake; uninterrupted polling still catches stalled writes.
    if (at - lastPoll > staleMs && partial) partialSince = at;
    lastPoll = at;
    reading = true;
    try {
      const info = await stat(file);
      existed = true;
      if (onHealth && info.size < offset) { health('error', 'Native transcript was truncated; restart tracking before coordinating.'); return; }
      if (info.size < offset) { offset = 0; partial = ''; decoder = new StringDecoder('utf8'); }
      if (info.size === offset) {
        if (partial && partialSince !== null && now() - partialSince >= partialTimeoutMs) health('error', 'Native transcript has an incomplete record that stopped advancing.');
        else health(partial || !understood ? 'pending' : 'healthy');
        return;
      }
      if (onHealth && info.size - offset > 4 * 1024 * 1024) { health('error', 'Native transcript advanced beyond the tracking window.'); return; }
      if (info.size - offset > 4 * 1024 * 1024) { offset = info.size - 4 * 1024 * 1024; partial = ''; decoder = new StringDecoder('utf8'); }
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(info.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        let recordOffset = offset - Buffer.byteLength(partial) - (decoder.lastNeed ? decoder.lastTotal - decoder.lastNeed : 0);
        offset += bytesRead;
        const lines = (partial + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        partial = lines.pop() || '';
        partialSince = partial ? (partialSince ?? now()) : null;
        for (const line of lines) {
          if (!line.trim()) { recordOffset += Buffer.byteLength(line) + 1; continue; }
          let record;
          try {
            record = JSON.parse(line);
          } catch { if (onHealth) { health('error', 'Native transcript contains invalid JSON.'); return; } }
          if (record) {
            const problem = nativeRecordProblem(record, agent);
            if (onHealth && problem) { health('error', problem); return; }
            if (!problem && !closed) onRecord?.(record);
            if (['user', 'assistant', 'event_msg', 'response_item'].includes(record.type) && !(agent==='grok' && grokSynthetic(record))) understood = true;
            const event = nativeActivity(record, agent);
            // Providers without message IDs still get a stable identity on reread.
            if (event?.kind === 'turn-completed' && !event.id) event.id = `${file}:${recordOffset}`;
            if (event && !closed) onEvent(event);
          }
          recordOffset += Buffer.byteLength(line) + 1;
        }
        health(partial || !understood ? 'pending' : 'healthy');
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ENOENT' && !existed) health('pending');
      else health('error', `Native transcript unavailable (${error.code || 'read failure'}).`);
    }
    finally { reading = false; }
  };
  let inFlight = null;
  const poll = () => inFlight ||= tick().finally(() => { inFlight = null; });
  const timer = setInterval(poll, interval); timer.unref(); void poll();
  const stop = () => { closed = true; clearInterval(timer); };
  // A process may write its final record between the last stat and its exit.
  stop.flush = async () => { await poll(); await poll(); };
  return stop;
}

export async function claudeTranscript(cwd, nativeId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const folders = await readdir(root).catch(() => []);
  // Claude names the folder after getcwd(). Chats saved before working folders
  // were stored resolved may hold a symlinked or differently normalised spelling.
  const spellings = [cwd];
  if (process.platform !== 'win32') spellings.push(await realpath(cwd).catch(() => cwd));
  for (const spelling of spellings) {
    const escaped = spelling.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const folder = folders.find(item => item.toLowerCase() === escaped);
    if (folder) return path.join(root, folder, `${nativeId}.jsonl`);
  }
  return path.join(root, spellings.at(-1).replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`);
}

export { codexTranscript } from './codex-history.mjs';
