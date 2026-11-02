import { setTimeout as delay } from 'node:timers/promises';
import { unwrapPastes } from './mobile-transcript.mjs';
import { attentionPresentation } from './station-vocabulary.mjs';
import { grokText, grokSynthetic, grokFinal } from './grok-records.mjs';

export const freshSeatEligible = seat => !!seat.watcher?.canBootstrap?.() && !seat.resumeId
  && (seat.inputVersion || 0) === (seat.bootstrapInputVersion || 0)
  && seat.attention?.watcher?.state !== 'error'
  && ['process', 'screen'].includes(seat.attention?.source) && seat.attention?.activity !== 'failed';

export function readinessProblem(seat, { prompt = null, owner = null, fresh = false } = {}) {
  if (!seat?.alive || seat.stopping || seat.attention?.lifecycle !== 'running') return 'agent is not running';
  if (seat.localCommand) return `close ${seat.localCommand} in its terminal with Esc, then return to the table and press Enter`;
  if (prompt) return 'resolve the agent menu or approval prompt';
  if (seat.deliveryPending && seat.deliveryPending !== owner) return 'another delivery is pending';
  if (seat.draftDirty) return 'finish or clear the draft in its terminal';
  if (fresh && freshSeatEligible(seat)) return null;
  if (!seat.watcher || seat.attention?.watcher?.state !== 'healthy') return seat.attention?.watcher?.error || 'native tracking is not ready; send a normal message and let it finish';
  if (attentionPresentation(seat).kind === 'unverified') return 'native readiness is unverified; send a normal message and let it finish';
  if (!['idle', 'completed'].includes(seat.attention.activity)) return `agent is ${seat.attention.activity}; finish the turn or resolve its error`;
  return null;
}

// Bootstrap requires an observed native input cursor, not elapsed silence or a
// generic '>' anywhere in scrollback. It is limited to untouched fresh seats.
export function freshPromptReady(agent, terminal) {
  if (!['claude', 'codex'].includes(agent) || !terminal) return false;
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) return false;
  const before = line.translateToString(false, 0, buffer.cursorX).trim();
  const after = line.translateToString(true, buffer.cursorX).trim();
  if (!/^[❯›>]$/.test(before)) return false;
  const screen = Array.from({ length: terminal.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) || '').join('\n');
  if (/esc(?:ape)?\s+(?:to\s+)?interrupt/i.test(screen)) return false;
  if (agent === 'codex') return /OpenAI Codex/.test(screen) && (!after || after === 'Ask Codex to do anything');
  return /Claude Code/.test(screen) && (!after || /^Try ["“].+["”]$/.test(after));
}

// The gate is checked before paste AND Enter. If the second check fails, leave
// the draft for the owner; never send cleanup keystrokes into an approval menu.
export async function guardedDelivery({ seat, proc, current, prompt, refresh, capture = async () => null, onSubmit, text, wait = () => delay(500), freshReady = null }) {
  const owner = {}, inputVersion = seat.inputVersion || 0;
  let pasted = false;
  const check = () => {
    if (!current() || (seat.inputVersion || 0) !== inputVersion) throw new Error('The seat or its input changed during delivery.');
    const problem = readinessProblem(seat, { prompt: prompt(), owner, fresh: !!freshReady && (pasted || freshReady()) });
    if (problem) throw new Error(problem);
  };
  check(); seat.deliveryPending = owner;
  try {
    await refresh(); check();
    const request = await capture(); check();
    proc.write(`\x1b[200~${text}\x1b[201~`); pasted = true;
    await wait(); await refresh(); check();
    proc.write('\r'); onSubmit(request);
    return request;
  } catch (error) {
    if (pasted) { seat.draftDirty = true; throw new Error(`${error.message} Enter was not sent; inspect the draft in this seat.`); }
    throw error;
  } finally { if (seat.deliveryPending === owner) seat.deliveryPending = null; }
}

const normalize = text => unwrapPastes(String(text).replace(/\r\n?/g, '\n')).trim();
const parts = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => ['text', 'input_text', 'output_text'].includes(part?.type)).map(part => part.text || '').join('\n') : '';

// This reader is deliberately separate from the display reader: it never uses
// "latest assistant text", truncated previews, or a completion-version baseline.
export function correlatedResponse(records, agent, request) {
  if (agent === 'codex' && request.storage === 'sqlite') {
    const candidates = records.filter(record => record.payload?.role === 'user' && !request.turns.includes(record.nativeTurnId) && normalize(parts(record.payload.content)) === normalize(request.text));
    if (candidates.length > 1) throw new Error('Ambiguous table prompt: multiple native turns match.');
    const user = candidates[0];
    if (!user) return null;
    if (['interrupted', 'failed'].includes(user.nativeStatus)) throw new Error('The table request was interrupted or failed.');
    if (user.nativeStatus !== 'completed') return null;
    const answers = records.filter(record => record.nativeTurnId === user.nativeTurnId && record.payload?.role === 'assistant' && ['final', 'final_answer'].includes(record.payload.phase));
    const answer = answers.at(-1);
    if (!answer || !parts(answer.payload.content).trim()) throw new Error('The completed table request has no supported final answer.');
    return { text: parts(answer.payload.content), userId: user.uuid, answerId: answer.uuid, turnId: user.nativeTurnId };
  }
  const entries = [];
  let turnId = null;
  const userEvents = records.some(record => record.type === 'event_msg' && record.payload?.type === 'user_message');
  const userItems = records.some(record => record.type === 'event_msg' && record.payload?.type === 'item_completed' && record.payload.item?.type === 'UserMessage');
  for (const [position, record] of records.entries()) {
    if (record.isSidechain || record.isMeta) continue;
    const entry = { position, id: record.uuid || record.id || record.message?.id || String(position), turnId };
    if (agent === 'claude') {
      const content = record.message?.content;
      if (record.type === 'user' && !(Array.isArray(content) && content.some(part => part.type === 'tool_result'))) {
        const text = parts(content);
        if (text.startsWith('[Request interrupted by user')) entries.push({ ...entry, kind: 'interrupted' });
        else if (text) entries.push({ ...entry, kind: 'user', text });
      }
      if (record.type === 'assistant' && record.message?.stop_reason === 'end_turn' && parts(content)) entries.push({ ...entry, kind: 'final', text: parts(content) });
    } else if (agent === 'grok') {
      if (record.type === 'user' && !grokSynthetic(record)) entries.push({ ...entry, kind: 'user', text: grokText(record) });
      if (grokFinal(record)) entries.push({ ...entry, kind: 'final', text: grokText(record) });
    } else if (agent === 'codex') {
      const p = record.payload;
      if (record.type === 'event_msg') {
        if (p?.type === 'task_started') turnId = p.turn_id;
        if (p?.type === 'user_message' && userEvents) entries.push({ ...entry, turnId, kind: 'user', text: p.message });
        if (p?.type === 'item_completed' && p.item?.type === 'UserMessage' && !userEvents) entries.push({ ...entry, turnId, kind: 'user', text: parts(p.item.content) });
        if (p?.type === 'agent_message') entries.push({ ...entry, turnId, kind: 'text', text: p.message });
        if (p?.type === 'item_completed' && p.item?.type === 'AgentMessage') entries.push({ ...entry, turnId, kind: 'text', text: parts(p.item.content) });
        if (p?.type === 'task_complete') entries.push({ ...entry, turnId: p.turn_id || turnId, kind: 'complete', text: p.last_agent_message });
        if (p?.type === 'turn_aborted') entries.push({ ...entry, turnId: p.turn_id || turnId, kind: 'interrupted' });
      }
      if (record.type === 'response_item' && p?.type === 'message') {
        if (p.role === 'user' && !userEvents && !userItems) entries.push({ ...entry, turnId, kind: 'user', text: parts(p.content) });
        if (p.role === 'assistant' && p.phase !== 'commentary') entries.push({ ...entry, turnId, kind: 'text', text: parts(p.content) });
      }
    }
  }
  const matches = entries.filter(entry => entry.kind === 'user' && normalize(entry.text) === normalize(request.text));
  if (matches.length > 1) throw new Error('Ambiguous table prompt: multiple native messages match.');
  const user = matches[0];
  if (!user) return null;
  let lastText = null, answer = null;
  for (const entry of entries.filter(entry => entry.position > user.position)) {
    if (entry.kind === 'user' || entry.kind === 'interrupted') {
      if (!answer) throw new Error('The table request was interrupted or superseded before a final answer.');
      break;
    }
    if (user.turnId && entry.turnId && user.turnId !== entry.turnId) continue;
    if (entry.kind === 'text') lastText = entry;
    if (entry.kind === 'final') answer = entry;
    if (entry.kind === 'complete') {
      const text = entry.text || lastText?.text;
      if (!text) throw new Error('The completed table request has no supported final answer.');
      answer = { ...entry, text };
    }
  }
  return answer ? { text: answer.text, userId: user.id, answerId: answer.id, turnId: user.turnId || answer.turnId } : null;
}
