import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LEDGER_HOME } from './station-ledger.mjs';
import { readConversation, readableText, messageLines } from './station-conversation.mjs';
import { seatLabel, emphasizePosture } from './station-vocabulary.mjs';

export const handoffMarker = id => `Station handoff request ${id}`;
export const handoffEnd = id => `<!-- station-handoff:${id}:end -->`;
export function handoffRequest(id) {
  return `${handoffMarker(id)}: Prepare a fresh chat to continue this work in the same project. Do not change files, run commands, or continue the task. Reply with Markdown only, beginning with # Handoff. Include these headings: ## Goal, ## Current state, ## Decisions, ## Files, ## Open problems, ## Next steps. Preserve constraints, decisions and their reasons, relevant paths, commands, IDs, tests run and their results, and the exact next action. Clearly label assumptions and unverified work. Do not include credentials. End with this exact marker: ${handoffEnd(id)}`;
}

export function handoffText(messages, id) {
  const index = messages.findLastIndex(message => message.role === 'user' && message.text.includes(handoffMarker(id)));
  if (index < 0) return null;
  const after = messages.slice(index + 1);
  if (after.some(message => message.role === 'user')) throw new Error('The source conversation received another prompt. Request a new handoff for its current state.');
  const reply = after.filter(message => message.role === 'assistant').at(-1)?.text || '';
  if (!/^# Handoff\s*\n/.test(reply) || !reply.trimEnd().endsWith(handoffEnd(id))) return null;
  for (const heading of ['Goal', 'Current state', 'Decisions', 'Files', 'Open problems', 'Next steps']) {
    if (!reply.split('\n').some(line => line.trim() === `## ${heading}`)) return null;
  }
  return reply.trim();
}

export function continuationPrompt(file) {
  return `Continue the work from the previous chat. First read the handoff at: ${file}. It records the goal, decisions, constraints, files, verification, and next steps. Check the current repository state before acting. State the next step briefly, then continue within the existing scope.`;
}

export function waitForContinuation(proc, { onData, signal, timeoutMs = 15000, settleMs = 800, label = 'continuation', failureNote = 'The original is unchanged.' } = {}) {
  return new Promise((resolve, reject) => {
    let settle = null, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearTimeout(settle);
      signal?.removeEventListener('abort', abort);
      exited.dispose();
      if (error) { output.dispose(); reject(error); }
      else resolve({ dispose: () => output.dispose() });
    };
    const abort = () => finish(new Error('Rellin closed before the continuation started.'));
    const output = proc.onData(data => {
      onData(data);
      // ConPTY emits terminal-mode controls before the executable has started.
      if (!settle && stripVTControlCharacters(data).replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim()) settle = setTimeout(() => finish(), settleMs);
    });
    const exited = proc.onExit(event => finish(new Error(`The ${label} exited during startup (code ${event.exitCode}). ${failureNote}`)));
    const timeout = setTimeout(() => finish(new Error(`The ${label} did not start in time. ${failureNote}`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class StationHandoffs {
  constructor({ getSeat, persist, submit, launch, tableActive = () => false, cwd, dir = LEDGER_HOME, read = readConversation, timeoutMs = 15 * 60_000, pollMs = 250 }) {
    Object.assign(this, { getSeat, persist, submit, launch, tableActive, cwd, dir, read, timeoutMs, pollMs });
    this.pending = new Map();
    this.closed = false;
  }
  state(index) { return this.getSeat(index).handoff || null; }
  update(index, patch) {
    if (this.closed) throw new Error('Rellin is closing.');
    const job = { ...this.state(index), ...patch, updatedAt: new Date().toISOString() };
    this.persist(index, job);
    return job;
  }
  start(index) {
    if (this.pending.has(index)) return this.pending.get(index);
    const promise = this.perform(index).catch(error => {
      if (!this.closed) this.update(index, { status: 'failed', error: readableText(error.message) });
      return this.state(index);
    }).finally(() => this.pending.delete(index));
    this.pending.set(index, promise);
    return promise;
  }
  check(index) {
    if (this.closed) throw new Error('Rellin is closing.');
    const seat = this.getSeat(index);
    if (!['claude', 'codex'].includes(seat.agent)) throw new Error('Fresh-chat handoff currently supports Claude and Codex.');
    if (!seat.alive) throw new Error('This agent has stopped. Resume its conversation before requesting a handoff.');
    if (!seat.watcher) throw new Error('Native tracking is unavailable for this seat. Codex needs --no-daemon support; restart Rellin after updating the CLI.');
    if (!seat.nativeId) throw new Error('No saved conversation yet. Send a first message to the agent and let it finish, then retry Alt+H. If you already have, Rellin has not captured its history yet.');
    if (this.tableActive()) throw new Error('End the table discussion before handing off a seat.');
    if (['working', 'waiting', 'failed'].includes(seat.attention.activity)) throw new Error('Finish the current turn or resolve the agent prompt/error before handoff.');
  }
  async perform(index) {
    this.check(index);
    const seat = this.getSeat(index);
    let job = this.state(index);
    // Retrying a failed launch reuses the saved summary without another model call.
    if (!job || job.sourceNativeId !== seat.nativeId || job.status === 'done') job = null;
    let text = null;
    if (job?.id && !job.file) {
      try { text = handoffText((await this.read(seat, this.cwd)).messages, job.id); } catch { /* A new explicit request will summarize the newer state. */ }
    }
    if (job?.file) {
      // Reuse only if the original has not advanced since the saved summary.
      let stillCurrent;
      try { stillCurrent = handoffText((await this.read(seat, this.cwd)).messages, job.id); } catch { }
      if (!stillCurrent) job = null;
      else if (!(await stat(job.file).catch(() => null))?.isFile()) { text = stillCurrent; job = { ...job, file: null }; }
    }
    if (!job?.file) {
      if (!text) {
        const id = randomUUID();
        job = this.update(index, { id, status: 'summarizing', sourceNativeId: seat.nativeId, baseline: seat.attention.completionVersion, file: null, error: null, sourceArchiveId: null });
        await this.submit(index, handoffRequest(id));
        const deadline = Date.now() + this.timeoutMs;
        while (!this.closed) {
          const current = this.getSeat(index);
          if (current.nativeId !== job.sourceNativeId) throw new Error('The source conversation changed during handoff.');
          if (current.attention.completionVersion > job.baseline) {
            text = handoffText((await this.read(current, this.cwd)).messages, job.id);
            if (!text) throw new Error('The agent did not return a complete structured handoff. Review its answer and retry.');
            break;
          }
          if (!current.alive || current.attention.activity === 'failed') throw new Error('The agent stopped or reported an error before completing its handoff.');
          if (Date.now() >= deadline) throw new Error('No handoff after the time limit. Check for an approval prompt, then retry.');
          await delay(this.pollMs);
        }
      }
      if (this.closed) throw new Error('Rellin is closing.');
      const folder = path.join(this.dir, 'handoffs');
      await mkdir(folder, { recursive: true });
      const file = path.join(folder, `${job.id}.md`);
      await writeFile(file, `${text}\n`, { encoding: 'utf8', mode: 0o600 });
      job = this.update(index, { status: 'ready', file, error: null });
    }
    if (this.closed) throw new Error('Rellin is closing.');
    if (this.tableActive()) throw new Error('A table discussion started during handoff. End it and retry.');
    this.update(index, { status: 'opening', error: null });
    const link = await this.launch(index, job);
    return this.update(index, { ...job, status: 'done', ...link, error: null });
  }
  stop() { this.closed = true; }
}

// Paint only a centered rectangle. The surrounding agent panes stay visible.
export function renderHandoffPopup({ seat, job, error, pending = false }, columns = 100, rows = 30) {
  const width = Math.max(4, Math.min(76, columns - 2)), inner = width - 4;
  const lines = ['Fresh-chat handoff', `${seatLabel(seat)} (${seat.agent})`, '',
    pending ? 'Handoff is running. Return to the agent to watch progress.' : 'Save a summary and continue in a fresh chat with the same settings.',
    'The original stays in history.', '',
    `Status: ${job?.status || 'ready'}`, error || job?.error || '',
    pending ? 'Enter / Esc back' : 'Enter start / retry   Esc cancel'];
  const body = lines.flatMap(line => messageLines(line, inner)).slice(0, Math.max(1, rows - 4));
  const height = body.length + 2, left = Math.max(1, Math.floor((columns - width) / 2) + 1), top = Math.max(1, Math.floor((rows - height) / 2) + 1);
  const framed = ['┌' + '─'.repeat(width - 2) + '┐', ...body.map(line => '│ ' + line.padEnd(inner) + ' │'), '└' + '─'.repeat(width - 2) + '┘'];
  return '\x1b[?25l\x1b[0m' + framed.map((line, row) => `\x1b[${top + row};${left}H\x1b[48;5;236m\x1b[38;5;252m${emphasizePosture(line)}\x1b[0m`).join('');
}

export function showHandoff({ manager, index, seat, redrawBackground = () => {} }) {
  return new Promise(resolve => {
    let error = null, lastFrame = null;
    const draw = () => {
      const frame = renderHandoffPopup({ seat, job: manager.state(index), error, pending: manager.pending.has(index) }, process.stdout.columns, process.stdout.rows);
      if (frame === lastFrame) return;
      lastFrame = frame;
      redrawBackground(); process.stdout.write(frame);
    };
    const finish = quit => { clearInterval(timer); process.stdin.removeListener('data', onData); process.stdout.removeListener('resize', draw); resolve({ quit }); };
    const onData = chunk => {
      if (chunk === '\x1b') return finish(false);
      if (chunk === '\x11') return finish(true);
      if (chunk === '\r') {
        if (manager.pending.has(index)) return finish(false);
        try { manager.check(index); } catch (caught) { error = readableText(caught.message); draw(); return; }
        void manager.start(index);
        finish(false);
      }
    };
    const timer = setInterval(draw, 250);
    process.stdin.on('data', onData); process.stdout.on('resize', draw); draw();
  });
}
