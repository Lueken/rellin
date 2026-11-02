import { stripVTControlCharacters } from 'node:util';

// Shared vocabulary only: layouts remain the responsibility of each surface.
export const GLYPHS = { idle: '●', working: '◐', blocked: '■', done: '✓', unverified: '◌', error: '▲', exited: '✕', empty: '○' };
export const STATE_COLORS = { idle: '\x1b[32m', working: '\x1b[33m', blocked: '\x1b[31m', done: '\x1b[32m', unverified: '\x1b[35m', error: '\x1b[31m', exited: '\x1b[2m', empty: '\x1b[2m' };
export const EVIDENCE = { native: '', screen: '?scr', timer: '?tmr', input: '?inp', process: '?prc' };
export const READ_ONLY = 'asked, not enforced';
export const cleanLabel = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export const elapsedLabel = seconds => `${Math.floor(Math.max(0, seconds || 0) / 60)}:${String(Math.floor(Math.max(0, seconds || 0) % 60)).padStart(2, '0')}`;
export const plainWidth = text => [...stripVTControlCharacters(String(text))].length;

// Clip generated SGR text without cutting an escape sequence or leaking styles.
export function clipLabel(text, width) {
  let result = '', used = 0;
  for (const token of String(text).match(/\x1b\[[0-9;]*m|[^]/gu) || []) {
    if (token.startsWith('\x1b[')) result += token;
    else { if (used >= Math.max(0, width)) break; result += token; used++; }
  }
  return result + '\x1b[0m';
}
export const posture = seat => seat.bypass || seat.mode === 'auto' ? '\x1b[7mBYPASS\x1b[27m' : '';
export const seatLabel = seat => `${cleanLabel(seat.seat || seat.agent)}${posture(seat) ? ' ' + posture(seat) : ''}`;
// Used after untrusted popup copy has been sanitized/wrapped.
export const emphasizePosture = text => text.replace(/\bBYPASS\b/g, '\x1b[7mBYPASS\x1b[27m');

export function attentionPresentation(seat, now = Date.now()) {
  const a = seat.attention, unread = Math.max(0, (a?.completionVersion || 0) - (a?.readVersion || 0));
  let kind, detail = '', source = a?.source;
  const uncertain = !a || a.watcher?.state !== 'healthy';
  if (seat.alive === false || ['stopped', 'failed'].includes(a?.lifecycle)) {
    kind = 'exited'; source = 'process'; detail = a?.exitCode ? String(a.exitCode) : '';
  } else if (a?.activity === 'waiting' && a.waitReason === 'prompt') {
    kind = 'blocked'; source = 'screen'; detail = a.promptKind || 'choice';
  } else if (uncertain) {
    kind = 'unverified'; source = null;
  } else if (a.activity === 'failed') {
    kind = 'error'; detail = cleanLabel(a.providerCode ?? a.error ?? 'provider');
  } else if (a.activity === 'waiting') {
    kind = 'blocked'; detail = a.waitReason === 'timeout' ? 'turn limit' : 'waiting';
  } else if (a.activity === 'working') {
    kind = 'working'; detail = elapsedLabel((now - (a.turnStartedAt ?? now)) / 1000);
  } else if (unread) { kind = 'done'; source = 'native'; }
  else if (!a.completionVersion && !seat.resumeId) { kind = 'empty'; }
  else if (a.source === 'native' && a.lifecycle === 'running') { kind = 'idle'; }
  else { kind = 'unverified'; source = null; }
  const evidence = EVIDENCE[source] || '';
  let label = kind + (detail ? (['working', 'exited'].includes(kind) ? ' ' : ' · ') + detail : '');
  if (evidence) label += ` ${evidence}`;
  if (uncertain && kind === 'blocked') label += ' · ◌ unverified';
  if (unread) label += ` · ${unread} unread`;
  const priority = kind === 'blocked' ? 0 : kind === 'unverified' ? 1 : kind === 'error' || kind === 'exited' && a?.exitCode ? 2 : unread ? 3 : null;
  return { kind, glyph: GLYPHS[kind], label, evidence, unread, priority, readVersion: a?.completionVersion || 0,
    reason: a?.watcher?.error || (kind === 'unverified' ? 'Native tracking is not verified.' : detail) };
}
export function attentionLabel(seat, now) {
  const item = attentionPresentation(seat, now);
  return `${item.glyph} ${item.label}`;
}
export function attentionOrder(seats) {
  return seats.map((seat, index) => ({ index, priority: attentionPresentation(seat).priority }))
    .filter(item => item.priority !== null).sort((a, b) => a.priority - b.priority || a.index - b.index).map(item => item.index);
}
export function nextAttention(seats, focus) {
  const ordered = attentionOrder(seats);
  if (!ordered.length) return null;
  const at = ordered.indexOf(focus);
  return ordered[(at + 1) % ordered.length];
}
