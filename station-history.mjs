import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LEDGER_HOME, readLedger, recordingIssueLabel } from './station-ledger.mjs';
import { claudeTranscript, codexTranscript } from './native-events.mjs';
import { codexDbThreads, codexDbTurns } from './codex-db.mjs';
import { seatLabel } from './station-vocabulary.mjs';

export const USAGE = `Usage:
  rellin [--seats claude,codex[:model[:effort[:mode]]]] [--dir folder] [--name title]
  rellin --history [--dir folder]
  rellin --resume <id-prefix|latest> [--dir folder] [--name title]
  rellin --help

One to four agents; table discussions require at least two.
Run without --seats or --resume to choose a project and session interactively.
Optional: --ledger mirror.jsonl. Legacy --layout grid|columns is accepted;
the Console uses a fixed shelf and one work surface.
Resume restores native conversations, not running processes or an unfinished table.`;

export function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--help', '--history'].includes(key)) options[key.slice(2)] = true;
    else if (['--seats', '--dir', '--ledger', '--layout', '--name', '--resume'].includes(key)) {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
      options[key.slice(2)] = value;
    } else throw new Error(`Unknown option ${key}\n${USAGE}`);
  }
  if (options.resume && options.seats) throw new Error('Use --resume or --seats, not both.');
  if (options.history && (options.resume || options.seats || options.name || options.ledger || options.layout)) throw new Error('--history accepts only --dir.');
  if (options.name && (options.name.length > 120 || /[\x00-\x1f\x7f-\x9f]/.test(options.name))) throw new Error('Use a name of 1–120 characters without control characters.');
  if (options.layout && !['grid', 'columns'].includes(options.layout)) throw new Error('Layout must be grid or columns.');
  return options;
}

const folderKey = folder => process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder);
export function loadHistory({ dir = LEDGER_HOME, cwd } = {}) {
  const file = path.join(dir, 'station.db');
  if (!existsSync(file)) return [];
  const ledger = readLedger(file);
  try { return ledger.history().filter(run => !cwd || folderKey(run.cwd) === folderKey(cwd)); }
  finally { ledger.close(); }
}

export function selectRun(runs, selector) {
  if (!runs.length) throw new Error('No saved Rellin runs found.');
  if (selector === 'latest') return runs[0];
  const matches = runs.filter(run => run.id.startsWith(selector));
  if (!matches.length) throw new Error(`No Rellin run matches "${selector}". Use --history to find its ID.`);
  if (matches.length > 1) throw new Error('That ID prefix matches several runs. Use a longer prefix.');
  return matches[0];
}

const safeText = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function formatHistory(runs) {
  if (!runs.length) return 'No saved Rellin runs. Start one with rellin --name "My task".';
  return ['ID          STARTED                   STATE      NAME / AGENTS / FOLDER', ...runs.map(run => {
    const known = run.seats.every(seat => ['claude', 'codex', 'grok'].includes(seat.agent) && seat.nativeId);
    const status = run.active ? 'active' : known ? 'saved' : 'legacy';
    const recording = run.recordingIssues?.length ? ` / ${recordingIssueLabel(run.recordingIssues)} (see recording-gap events)` : '';
    const links = run.seats.flatMap(seat => seat.handoffFrom ? [`from ${seat.handoffFrom.sourceArchiveId.slice(0, 8)}`] : seat.handoffTo ? [`continued in ${seat.handoffTo.destinationStationId.slice(0, 8)}`] : []);
    return `${run.id.slice(0, 8)}    ${run.started_at}  ${status.padEnd(9)}  ${safeText(run.name || path.basename(run.cwd))} / ${run.seats.map(seat => seatLabel(seat)).join(', ')} / ${safeText(run.cwd)}${links.length ? ` / ${links.join(', ')}` : ''}${recording}`;
  }), '', 'Resume: rellin --resume <id-prefix>. Saved means IDs recorded; native history must still exist.', 'Legacy runs lack supported native IDs and cannot be resumed automatically.'].join('\n');
}

// Capture offsets before spawn: past answers must not become new completions.
export async function prepareResume(run) {
  if (run.active) throw new Error('This Rellin run is still active. Close it before resuming.');
  if (!(await stat(run.cwd).catch(() => null))?.isDirectory()) throw new Error(`Working folder is missing: ${run.cwd}`);
  const seats = [];
  for (const seat of run.seats) {
    const validId = seat.agent === 'grok' ? /^[a-z0-9][a-z0-9_-]{0,127}$/i : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    if (!['claude', 'codex', 'grok'].includes(seat.agent) || !validId.test(seat.nativeId || '')) {
      throw new Error(`Cannot resume ${seat.seat || seat.agent}: no supported native conversation ID was saved. Start a new run with --seats.`);
    }
    const stored = seat.agent === 'codex' && codexDbThreads({ id: seat.nativeId })[0];
    if (stored) {
      let turns;
      try { turns = codexDbTurns(seat.nativeId); }
      catch { throw new Error(`Native history for ${seat.seat || seat.agent} is unavailable. Its conversation was not replaced.`); }
      seats.push({ ...seat, mode: seat.bypass ? 'auto' : 'manual', resumeId: seat.nativeId, boundary: { storage: 'sqlite', file: stored.file, nativeId: seat.nativeId, turns } });
      continue;
    }
    const file = seat.agent === 'claude' ? await claudeTranscript(run.cwd, seat.nativeId)
      : seat.agent === 'codex' ? await codexTranscript(seat.nativeId)
        : path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(run.cwd), seat.nativeId, 'chat_history.jsonl');
    const info = file && await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Native history for ${seat.seat || seat.agent} is missing. Its conversation was not replaced.`);
    seats.push({ ...seat, mode: seat.bypass ? 'auto' : 'manual', resumeId: seat.nativeId, boundary: { file, offset: info.size } });
  }
  return seats;
}
