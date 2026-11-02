// Per-seat turn watcher for the station (table-mode.md §5): native
// transcripts are the truth about turn boundaries and final messages — never
// the screen, never completedTurn()'s 350-char preview. Claude's transcript
// path is known before spawn (--session-id); Codex rollouts are discovered
// by the per-seat originator override and re-pointed on rewind/new threads
// (the sessions.mjs:254-283 lifecycle, without a Sessions instance).
import { readFile, stat, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeTranscript, tailNativeFile, nativeRecordProblem } from './native-events.mjs';
import { codexSegments, findCodexChat, newerCodexRollout } from './codex-history.mjs';
import { codexDbRecords, codexDbTurns, tailCodexDb } from './codex-db.mjs';
import { correlatedResponse } from './station-coordination.mjs';
import { transcriptMessages, transcriptText } from './mobile-transcript.mjs';
import { grokText, grokFinal } from './grok-records.mjs';
import { cacheObserver } from './station-cache.mjs';

// Pure: the last assistant message's full text from parsed records.
export function finalAssistantText(records, agent) {
  if (agent === 'grok') {
    for (let index = records.length - 1; index >= 0; index--) {
      if (grokFinal(records[index])) return grokText(records[index]);
    }
    return null;
  }
  const messages = transcriptMessages(records, agent);
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant' && messages[index].text) return messages[index].text;
  }
  return null;
}

export function parseRecords(text) {
  return String(text).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// Pure: token usage for one seat's session from parsed records. Claude
// writes per-call usage on assistant records (dedupe by message id, last
// revision wins); Codex writes cumulative token_count events (last wins).
export function usageFromRecords(records, agent) {
  if (agent === 'grok') return null; // Grok's chat history carries no usage.
  const usage = { input: null, output: null, cacheRead: null, cacheWrite: null };
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (agent === 'codex') {
    for (const record of records) {
      const info = record?.payload?.info?.total_token_usage || (record?.payload?.type === 'token_count' ? record.payload.info?.total_token_usage : null);
      if (!info) continue;
      usage.input = count(info.input_tokens);
      usage.output = count(info.output_tokens) === null ? null : info.output_tokens + (count(info.reasoning_output_tokens) || 0);
      usage.cacheRead = count(info.cached_input_tokens);
    }
    return Object.values(usage).some(value => value !== null) ? usage : null;
  }
  const byMessage = new Map();
  for (const record of records) {
    if (record?.type === 'assistant' && !record.isSidechain && record.message?.usage) byMessage.set(record.message.id || byMessage.size, record.message.usage);
  }
  for (const u of byMessage.values()) {
    for (const [key, field] of Object.entries({input:'input_tokens',output:'output_tokens',cacheRead:'cache_read_input_tokens',cacheWrite:'cache_creation_input_tokens'})) {
      if (count(u[field]) !== null) usage[key] = (usage[key] ?? 0) + u[field];
    }
  }
  return Object.values(usage).some(value => value !== null) ? usage : null;
}

// createTurnWatcher({agent, cwd, nativeId, onEvent}) → {stop, version, readFinal, readUsage}
// onEvent receives turn-started / turn-interrupted / attention unchanged and
// {kind:'completed', id, version} per finished turn — version is the
// station's completionVersion, for handoff.mjs-style baselines.
export function createTurnWatcher({ agent, cwd, nativeId, pid, onEvent, onIdentity = () => {}, onCache = () => {}, resumeId = null, boundary = null, progressTimeoutMs = 30000, staleMs = 10000, now = Date.now }) {
  let stopped = false, stopTail = null, repointTimer = null, discoverTimer = null;
  let health = { state: 'pending', error: null }, lastCheck = now(), progressTimer = null, progressMissing = false;
  let recovering = null, rechecking = false, nativeHealth = { state: 'pending', error: null };
  const progressNotice = 'No native turn observed yet; inspect the seat. The request will not be resent.';
  const recoveryNotice = 'Rechecking native history after a polling gap. The agent keeps running.';
  const report = next => {
    if (stopped || health.state === 'error') return;
    if (rechecking && ['pending', 'healthy'].includes(next.state)) next = { state: 'pending', error: recoveryNotice };
    if (progressMissing && ['pending', 'healthy'].includes(next.state)) next = { state: 'pending', error: progressNotice };
    if (next.state === health.state && next.error === health.error) return;
    health = next;
    onEvent({ kind: 'watcher-state', ...next });
  };
  const reportNative = next => { lastCheck = now(); nativeHealth = next; report(next); };
  const fault = error => report({ state: 'error', error: String(error.message || error).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 240) });
  let version = 0, file = null, storage = 'jsonl', currentNativeId = resumeId || nativeId, observedTurn = false;
  const completedIds = new Set();
  const bootstrapRequests = new WeakSet();
  const unboundBootstrapRequests = new Set();
  const canBootstrap = () => !stopped && !resumeId && !progressMissing && !rechecking && ['claude', 'codex'].includes(agent) && health.state !== 'error' && !observedTurn && version === 0;
  const bind = (nextFile, id, nextStorage = 'jsonl') => {
    if (stopped) return;
    stopTail?.();
    nativeHealth = { state: 'pending', error: null }; lastCheck = now();
    report({ state: 'pending', error: null });
    file = nextFile; currentNativeId = id; storage = nextStorage;
    for (const request of unboundBootstrapRequests) request.boundId = id;
    unboundBootstrapRequests.clear();
    observedTurn = false;
    onCache(null);
    const observeCache = cacheObserver(agent, observation => { if (!stopped && health.state !== 'error') onCache(observation); });
    onIdentity(id);
    stopTail = storage === 'sqlite'
      ? tailCodexDb(id, handle, { boundary: boundary?.nativeId === id ? boundary.turns : [], onHealth: reportNative })
      : tailNativeFile(file, agent, handle, boundary?.file === file ? boundary.offset : 0, { onHealth: reportNative, onRecord: observeCache, now, staleMs });
  };
  const handle = event => {
    if (!event || stopped || health.state === 'error') return;
    if (event.kind === 'turn-completed' && event.id && completedIds.has(`${currentNativeId}:${event.id}`)) return;
    if (['turn-started', 'turn-completed', 'turn-interrupted'].includes(event.kind)) observedTurn = true;
    clearTimeout(progressTimer); progressTimer = null; progressMissing = false;
    if (event.kind === 'turn-completed') {
      const key = `${currentNativeId}:${event.id}`;
      if (event.id && completedIds.has(key)) return;
      if (event.id) completedIds.add(key);
      version += 1;
      onEvent({ kind: 'completed', id: event.id, nativeId: currentNativeId, version });
      return;
    }
    onEvent(event);
  };
  const initialized = (async () => {
    if (agent === 'claude') {
      const path = await claudeTranscript(cwd, resumeId || nativeId);
      bind(path, resumeId || nativeId);
      return;
    }
    if (agent === 'grok') {
      // Grok registers running sessions by pid in active_sessions.json —
      // airtight attribution, since the station spawned the PTY.
      const home = path.join(os.homedir(), '.grok');
      let attempts = 0;
      const discover = async () => {
        if (stopped) return;
        try {
          const sessions = JSON.parse(await readFile(path.join(home, 'active_sessions.json'), 'utf8'));
          const mine = sessions.find(item => item.pid === pid);
          if (mine) {
            bind(path.join(home, 'sessions', encodeURIComponent(mine.cwd), mine.session_id, 'chat_history.jsonl'), mine.session_id);
            return;
          }
        } catch (error) { if (error.code !== 'ENOENT') { fault(new Error('Grok native session registry is unreadable or unsupported.')); return; } }
        discoverTimer = setTimeout(discover, ++attempts > 60 ? 3000 : 500);
        discoverTimer.unref?.();
      };
      return discover();
    }
    const fake = { id: nativeId, cwd, startedAt: Date.now(), createdAt: new Date().toISOString() };
    let attempts = 0;
    const discover = async () => {
      if (stopped) return;
      const match = resumeId && boundary ? { id: resumeId, file: boundary.file, storage: boundary.storage } : await findCodexChat(fake);
      if (stopped) return;
      if (!match) { discoverTimer = setTimeout(() => discover().catch(fault), ++attempts > 60 ? 3000 : 500); discoverTimer.unref?.(); return; }
      bind(match.file, match.id, match.storage);
      // Rewind segments and /new threads land in newer rollouts.
      repointTimer = setInterval(async () => {
        const newer = await newerCodexRollout(fake, file, { currentStorage:storage }).catch(error => { fault(error); return null; });
        if (stopped || !newer) return;
        bind(newer.file, newer.id, newer.storage);
      }, 2000);
      repointTimer.unref?.();
    };
    return discover();
  })().catch(fault);
  const recheckAfterGap = () => {
    if (stopped || recovering || health.state !== 'healthy' || now() - lastCheck <= staleMs) return;
    rechecking = true;
    report({ state: 'pending', error: recoveryNotice });
    // Resume the existing reader, retaining its byte offset/turn-status map.
    // Recreating it from EOF would lose answers; from zero would replay turns.
    recovering = Promise.resolve().then(async () => {
      await initialized;
      let checked;
      do { checked = stopTail; await checked?.flush?.(); }
      while (!stopped && checked !== stopTail);
      rechecking = false;
      if (!stopped) report(nativeHealth);
    }).catch(fault).finally(() => { rechecking = false; recovering = null; });
  };
  const readAll = async () => {
    if (storage === 'sqlite') return codexDbRecords(currentNativeId).records;
    const files = agent === 'codex' ? await codexSegments(currentNativeId).catch(() => []) : (file ? [file] : []);
    if (!files.length) return null;
    const { text } = await transcriptText(files);
    return parseRecords(text);
  };
  return {
    stop() { report({ state: 'stopped', error: null }); stopped = true; clearTimeout(progressTimer); stopTail?.(); if (repointTimer) clearInterval(repointTimer); if (discoverTimer) clearTimeout(discoverTimer); },
    health() {
      recheckAfterGap();
      return { ...health };
    },
    expectProgress({ manual = false } = {}) {
      // A fresh CLI's Enter can accept onboarding, configure a model, or close
      // a menu before there is any native turn to watch. Discovery remains
      // unverified until real events arrive; no timeout may poison that first
      // binding. Coordinated deliveries still always require progress.
      if (manual && (health.state !== 'healthy' || !observedTurn)) return;
      clearTimeout(progressTimer);
      // A delayed native record is uncertainty, not a broken parser. Keep
      // observing; only real native activity clears this state. Never resend.
      progressTimer = setTimeout(() => { progressMissing = true; report({ state: 'pending', error: progressNotice }); }, progressTimeoutMs);
      progressTimer.unref?.();
    },
    async refresh() {
      recheckAfterGap();
      await initialized;
      if (recovering) await recovering;
      else await stopTail?.flush?.();
      return this.health();
    },
    canBootstrap,
    async captureRequest(text, { bootstrap = false } = {}) {
      await this.refresh();
      if (bootstrap && canBootstrap()) {
        // The new conversation is owned by this watcher's launch UUID. It may
        // not have a transcript until the first submission. Match the exact
        // unique request marker after discovery; never borrow another seat.
        const request = { text, bootstrap: true, turns: [], offset: 0, boundId: file ? currentNativeId : null };
        bootstrapRequests.add(request);
        if (!file) unboundBootstrapRequests.add(request);
        return request;
      }
      if (stopped || health.state !== 'healthy') throw new Error(health.error || 'Native tracking is not ready.');
      const base = { text, nativeId: currentNativeId, storage, file };
      if (storage === 'sqlite') return { ...base, turns: codexDbTurns(currentNativeId).map(turn => turn.turn_id) };
      return { ...base, offset: (await stat(file)).size };
    },
    async readResponse(request) {
      try {
        await this.refresh();
        if (health.state === 'error') throw new Error(health.error);
        if (health.state !== 'healthy') return null;
        if (request.bootstrap) {
          if (!bootstrapRequests.has(request) || request.boundId && request.boundId !== currentNativeId) throw new Error('Native conversation changed during the first table request.');
          request.boundId = currentNativeId;
        } else if (request.nativeId !== currentNativeId || request.storage !== storage || request.file !== file) throw new Error('Native conversation or transcript changed during the table request.');
        let records;
        if (storage === 'sqlite') {
          const source = codexDbRecords(currentNativeId, { strict: true });
          if (source.limited) throw new Error('Table response exceeds the native history read window.');
          records = source.records;
        } else {
          const size = (await stat(file)).size;
          if (size < request.offset || size - request.offset > 4 * 1024 * 1024) throw new Error('Table response transcript position is no longer available.');
          const handle = await open(file, 'r');
          let text;
          try { const buffer = Buffer.alloc(size - request.offset); const { bytesRead } = await handle.read(buffer, 0, buffer.length, request.offset); text = buffer.subarray(0, bytesRead).toString('utf8'); }
          finally { await handle.close(); }
          if (text && !text.endsWith('\n')) return null;
          records = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
          for (const record of records) { const problem = nativeRecordProblem(record, agent); if (problem) throw new Error(problem); }
        }
        return correlatedResponse(records, agent, request.bootstrap ? { ...request, storage } : request);
      } catch (error) { fault(error); throw error; }
    },
    async finish() {
      await initialized;
      if (repointTimer) clearInterval(repointTimer);
      if (discoverTimer) clearTimeout(discoverTimer);
      await stopTail?.flush?.();
      this.stop();
    },
    version: () => version,
    async readFinal() {
      const records = await readAll();
      return records ? finalAssistantText(records, agent) : null;
    },
    async readUsage() {
      if (storage === 'sqlite') return null; // Do not present absent token breakdowns as zero usage.
      const records = await readAll();
      return records ? usageFromRecords(records, agent) : null;
    },
  };
}
