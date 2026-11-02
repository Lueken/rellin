#!/usr/bin/env node
// Rellin: the chair's seat wrapper (table-mode.md §4b, design: station
// mockups). One terminal, two to four seat CLIs on PTYs underneath. The
// wrapper reads stdin first and composites every view from the seats'
// headless buffers — the harness owns each pane's border header and the
// status bar; a seat's own UI runs untouched inside its pane.
//
//   station                               — setup screen (click to configure)
//   station --seats claude:opus:high,codex --dir <folder> --ledger <mirror.jsonl>
//
// Global command: `npm link` in desktop/service puts `station` on PATH; seats
// work in the directory it was launched from, and the session record lives in
// ~/.mrmak/station.db — the station never drops files into the launch repo.
//
// Alt+1..4 focuses a seat; Alt+G zooms the focused seat (others in a rail);
// Alt+Shift+1..4 opens the address overlay with that seat selected and
// toggles seats while it is open; Alt+` addresses everyone; Enter sends;
// Alt+Enter is a newline; Esc closes. Focus is not address. Ctrl+Q quits.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { AGENTS, childEnvironment, codexSupportsNoDaemon, inventory, terminalCommand } from './agents.mjs';
import { createTurnWatcher } from './station-turns.mjs';
import { renderTable, tableReduce } from './station-table.mjs';
import { prepareTableDelivery } from './station-table-delivery.mjs';
import { ptyOptions } from './platform.mjs';
import { terminalPrompt } from './terminal-prompt.mjs';
import { consoleLayout, createShelfDrag, cursorPosition, inner, paintComposer, paintContent, paintShelf, offsetSurface, surfaceLines, renderUsageModal, selectionText } from './station-view.mjs';
import { discoverOptions, runSetup } from './station-setup.mjs';
import { LEDGER_HOME, openLedger, recordingWarning } from './station-ledger.mjs';
import { USAGE, formatHistory, loadHistory, parseOptions, prepareResume, selectRun } from './station-history.mjs';
import { runStartup } from './station-startup.mjs';
import { showConversation, readConversation } from './station-conversation.mjs';
import { showFiles } from './station-files.mjs';
import { createAttentionTracker, initialAttention } from './station-attention.mjs';
import { StationHandoffs, continuationPrompt, showHandoff, waitForContinuation } from './station-handoff.mjs';
import { parseMouse, terminalLinkAt, openLink } from './station-links.mjs';
import { clipboardDraft, bracketedDraft, copyText } from './station-clipboard.mjs';
import { observeNativeInput, observeNativeScreen } from './station-native-input.mjs';
import { installInputFraming } from './station-input.mjs';
import { graphemes } from './station-markdown.mjs';
import { nextSeatName, removedSeatNavigation, seatMutationGuard, showSeatManager } from './station-seats.mjs';
import { seatPermissionEnvironment } from './station-permissions.mjs';
import { guardedDelivery, readinessProblem, freshPromptReady, freshSeatEligible } from './station-coordination.mjs';
import { attentionLabel, attentionOrder, nextAttention, seatLabel, clipLabel } from './station-vocabulary.mjs';
import { seatAccent, nextSeatAccent } from './station-identity.mjs';
import { openStationScreen, withLoading, STATION_MOUSE } from './station-screen.mjs';
import { configureShelf, shelfActionAt, usageLines } from './station-view.mjs';
import { readPreferences, saveShelfWidth, saveCacheReminders } from './station-preferences.mjs';
import { resolveBilling, newCacheState, acceptCacheObservation, cacheReminder } from './station-cache.mjs';
export { parseMouse } from './station-links.mjs';

const { Terminal } = headless;
const LAST_TABLE = path.join(LEDGER_HOME, 'station-last.json');
const SHIFTED = { '!': 0, '@': 1, '#': 2, '$': 3 };

// A seat spec is agent[:model[:effort[:mode]]]; "default"/empty parts skip;
// mode is manual (ask) or auto (bypass approvals).
export function parseSeatSpec(spec) {
  const [agent, model = 'default', effort = 'default', mode = 'manual'] = String(spec).split(':').map(part => part.trim());
  return { agent, model: model || 'default', effort: effort || 'default', mode: mode || 'manual' };
}

// A seat keeps one colour everywhere it appears (design rule). Duplicate
// seats of one agent take alternate accents so seat 3 is never mistaken for
// seat 1 at a glance.

export function decorateSeats(configs) {
  if (configs.length < 1 || configs.length > 4) throw new Error(`A station seats one to four agents.\n${USAGE}`);
  const counts = {};
  return configs.map((config, index) => {
    const agent = AGENTS.find(item => item.id === config.agent && item.id !== 'shell');
    if (!agent) throw new Error(`Unknown seat "${config.agent}". Agents: ${AGENTS.filter(item => item.id !== 'shell').map(item => item.id).join(', ')}.`);
    counts[config.agent] = (counts[config.agent] || 0) + 1;
    return {
      ...config, mode: config.mode === 'auto' ? 'auto' : 'manual', bypass: config.mode === 'auto',
      seat: config.seat || (counts[config.agent] > 1 ? `${config.agent}-${counts[config.agent]}` : config.agent),
      color: seatAccent(configs, index),
      alive: true, status: 'ready', turnStart: null, lastOutput: 0,
    };
  });
}

export function stationSeats(value = 'claude,codex') {
  const specs = String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (!specs.length) throw new Error('No seats. Pass --seats claude,codex');
  return decorateSeats(specs.map(parseSeatSpec));
}

// One framed input becomes one action. Chords are exactly ESC plus one
// byte; a lone ESC and multi-byte CSI sequences belong to the focused seat
// or, inside the composer, to the composer.
export function keyAction(chunk, state) {
  if (chunk === '\x11') return { type: 'quit' };
  // The usage modal swallows everything except its close keys.
  if (state.usageOpen) return chunk === '\x1bu' || chunk === '\x1b' ? { type: 'usage' } : { type: 'none' };
  if (chunk === '\x03' && !state.composer && state.view !== 'table' && state.selection?.moved && state.selection.seat === state.focus) return { type: 'copy-selection' };
  if (chunk === '\x03' && state.composer) return { type: 'none' };
  if (chunk === '\x16' || chunk === '\x1bv') return { type: 'clipboard' };
  if (chunk.length === 2 && chunk[0] === '\x1b') {
    const key = chunk[1];
    if (key === '`') return state.composer ? { type: 'compose', target: 'all' } : { type: 'view-table' };
    if (key === 'g') return { type: 'view' };
    if (key === 'e') return { type: 'table-end' };
    if (key === 'u') return { type: 'usage' };
    if (key === 't' && !state.composer) return { type: 'transcript' };
    if (key === 'o' && !state.composer) return { type: 'files' };
    if (key === 'h' && !state.composer) return { type: 'handoff' };
    if (key === 's' && !state.composer) return { type: 'seats' };
    if (key === 'n' && !state.composer) return { type: 'next-attention' };
    if (key === '\r') return state.composer ? { type: 'type', text: '\n' } : { type: 'passthrough', data: chunk };
    const digit = key >= '1' && key <= '4' ? Number(key) - 1 : undefined;
    if (digit !== undefined && digit < state.seats.length) return { type: 'focus', target: digit };
    if (key in SHIFTED && SHIFTED[key] < state.seats.length) return { type: 'compose', target: SHIFTED[key] };
  }
  if (!state.composer) return { type: 'passthrough', data: chunk };
  if (chunk === '\r') return { type: 'send' };
  if (chunk === '\x1b') return { type: 'cancel' };
  if (chunk === '\x7f' || chunk === '\b') return { type: 'erase' };
  if (chunk[0] === '\x1b' && !chunk.startsWith('\x1b[200~')) return { type: 'none' };
  const text = chunk.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '').replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, ' ');
  return text ? { type: 'type', text } : { type: 'none' };
}

// Pure state step. Opening the composer selects a target set; while open,
// Alt+Shift+N toggles membership and Alt+` selects everyone. Sending moves
// the sticky address (§4b); focus never does.
export function reduce(state, action) {
  switch (action.type) {
    case 'next-attention': {
      const target = nextAttention(state.seats, state.focus);
      return target === null ? [state, []] : [{ ...state, focus: target, view: 'console' }, [{ type: 'layout' }]];
    }
    case 'transcript': return [state, [{ type: 'transcript' }]];
    case 'files': return [state, [{ type: 'files' }]];
    case 'handoff': return [state, [{ type: 'handoff' }]];
    case 'seats': return [state, [{ type: 'seats' }]];
    case 'clipboard': return [state, [{ type: 'clipboard' }]];
    case 'copy-selection': return [state, [{ type: 'copy-selection' }]];
    case 'compose': {
      if (!state.composer) return [{ ...state, composer: { targets: action.target === 'all' ? 'all' : [action.target], text: '' } }, []];
      if (action.target === 'all') return [{ ...state, composer: { ...state.composer, targets: 'all' } }, []];
      const current = state.composer.targets === 'all' ? [] : state.composer.targets;
      const targets = current.includes(action.target) ? current.filter(item => item !== action.target) : [...current, action.target].sort();
      return [{ ...state, composer: { ...state.composer, targets } }, []];
    }
    case 'focus': {
      // From the table view, Alt+N opens that seat's pane directly (zoom).
      const view = 'console';
      if (action.target === state.focus && view === state.view) return [state, []];
      return [{ ...state, focus: action.target, view }, [{ type: 'layout' }]];
    }
    case 'view':
      return [{ ...state, view: 'console' }, [{ type: 'layout' }]];
    case 'view-table':
      return [{ ...state, view: state.view === 'table' ? 'console' : 'table' }, [{ type: 'layout' }]];
    case 'usage':
      return [{ ...state, usageOpen: !state.usageOpen }, [state.usageOpen ? { type: 'layout' } : { type: 'usageOpen' }]];
    case 'table-end':
      return [state, state.view === 'table' ? [{ type: 'tableEnd' }] : []];
    case 'type':
      return [{ ...state, composer: { ...state.composer, text: state.composer.text + action.text } }, []];
    case 'erase':
      return [{ ...state, composer: { ...state.composer, text: state.composer.text.slice(0, -1) } }, []];
    case 'cancel':
      return [{ ...state, composer: null }, [{ type: 'layout' }]];
    case 'send': {
      const text = state.composer.text.trim();
      const targets = state.composer.targets;
      if (!text || (targets !== 'all' && !targets.length)) return [state, []];
      return [{ ...state, composer: null, address: targets }, [{ type: 'send', targets, text }, { type: 'layout' }]];
    }
    case 'quit':
      return [state, [{ type: 'quit' }]];
    case 'passthrough':
      return [state, [{ type: 'write', to: state.focus, data: action.data }]];
    default:
      return [state, []];
  }
}

// ConPTY asks the hosting terminal for win32-input-mode in each child's
// output. The compositor never forwards seat output, but the scrub stays as
// a guard on the buffer path — a split sequence is held and dropped whole.
export function makeWin32InputScrub() {
  let tail = '';
  return chunk => {
    let data = tail + chunk;
    tail = '';
    data = data.replace(/\x1b\[\?9001[hl]/g, '');
    const partial = data.match(/\x1b(\[(\?(9(0(0(1)?)?)?)?)?)?$/);
    if (partial) { tail = partial[0]; data = data.slice(0, data.length - partial[0].length); }
    return data;
  };
}

const color = hex => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const addressLabel = address => address === 'all' ? '@all' : address.map(index => `@${index + 1}`).join(' ');

// Status bar, mockup variant A: three zones — colored tabs left, the sticky
// address in the middle, keys right — with the first hint pulled to
// attention when another seat needs you.
export function renderStatus(state, cols) {
  if (state.recordingWarning) return clipLabel(state.recordingWarning, cols);
  const prefix = ' ' + addressLabel(state.address) + ' · ';
  const job = state.seats[state.focus]?.handoff;
  const hint = state.interactionNotice || (job ? 'Handoff: ' + job.status + ' · Alt+H details' : null);
  const keys = state.view === 'table'
    ? 'Alt+1..4 terminal · Space pause · Alt+E end · Alt+` Console · ^Q quit'
    : 'Alt+1..4 focus · Alt+N attention · Alt+T read · Alt+` table · Alt+S seats · Alt+U usage · ^Q quit';
  const compact = 'Alt+N attention · Alt+T read · Alt+S seats · Alt+U usage · ^Q quit';
  return clipLabel(prefix + (hint || (prefix.length + keys.length <= cols ? keys : compact)), cols);
}

export function wrapText(text, width) {
  const lines = [];
  for (const raw of text.split('\n')) {
    let rest = raw;
    do { lines.push(rest.slice(0, width)); rest = rest.slice(width); } while (rest.length);
  }
  return lines;
}

export async function main(argv = process.argv.slice(2), { pasteClipboard = clipboardDraft, activateLink = openLink, copyClipboard = copyText } = {}) {
  const options = parseOptions(argv);
  if (options.help) { console.log(USAGE); return; }
  if (options.history) { console.log(formatHistory(loadHistory({ cwd: options.dir }))); return; }
  let previous = options.resume ? selectRun(loadHistory({ cwd: options.dir }), options.resume) : null;
  let restored = previous ? await prepareResume(previous) : null;
  let cwd = previous?.cwd || (options.dir ? path.resolve(options.dir) : process.cwd());
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run the station in a real terminal.');

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  const releaseInput = installInputFraming(process.stdin);
  configureShelf({...readPreferences(),onChange:width=>{try {saveShelfWidth(width);} catch { /* Keep resizing usable if preferences are read-only. */ }}});
  const releaseScreen = openStationScreen();
  const closeScreen = () => { releaseInput(); releaseScreen(); process.removeListener('exit', closeScreen); };
  process.once('exit', closeScreen);
  try {
  const last = await readFile(LAST_TABLE, 'utf8').then(JSON.parse).catch(() => null);

  let configs;
  if (restored) configs = decorateSeats(restored);
  else if (options.seats) configs = stationSeats(options.seats);
  else {
    const available = inventory().filter(agent => agent.available && agent.id !== 'shell').map(agent => agent.id);
    if (!available.length) throw new Error('No agent CLIs found. Install an agent CLI and make it available on PATH.');
    let draft;
    const discovered = new Map();
    while (!configs) {
      if (!discovered.has(cwd)) discovered.set(cwd, await withLoading('Loading agent options…', () => discoverOptions(process.env, cwd)));
      const chosen = await runSetup({ available, last, draft, cwd, manageScreen:false, ...discovered.get(cwd) });
      if (!chosen) { closeScreen(); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('No Rellin session.\r\n'); return; }
      if (chosen.browse) {
        draft = chosen.seats;
        const selected = await runStartup({ cwd, name: options.name, last: draft, returnToSetup: true, manageScreen:false });
        if (!selected) { closeScreen(); process.stdin.setRawMode(false); process.stdin.pause(); return; }
        if (selected.back) continue;
        cwd = selected.cwd;
        previous = selected.previous || null;
        restored = selected.restored || null;
        options.name = options.name || selected.name;
        if (restored) configs = decorateSeats(restored);
        continue;
      }
      configs = decorateSeats(chosen);
      await mkdir(path.dirname(LAST_TABLE), { recursive: true }).then(() => writeFile(LAST_TABLE, JSON.stringify(chosen, null, 2))).catch(() => {});
    }
  }

  let state = { seats: configs, focus: 0, address: [0], composer: null, view: 'console', selection: null, usageOpen: false };
  let cacheReminders = readPreferences().cacheReminders || false;
  const env = childEnvironment(cwd);
  const usableRows = () => process.stdout.rows - 1;
  let regions = [];

  const frame = () => consoleLayout(process.stdout.columns, process.stdout.rows);
  const layoutRegions = () => state.seats.map((seat, index) => index === state.focus ? frame().surface : null);
  let activitySeries = new Map(), activityReadAt = 0, readerSnapshot = null;
  const shelf = () => {
    const now = Date.now();
    if (now - activityReadAt >= 1000) { activitySeries = ledger.activitySeries(now - 135000); activityReadAt = now; }
    return paintShelf(frame().shelf, state.seats, state.focus, { colorOf: seat => color(seat.color), series: activitySeries, now, reader: readerSnapshot });
  };


  // The session record: always on, in ~/.mrmak/station.db (table-mode.md §3
  // — local to the machine, outside every repo), keyed to the repo the
  // station was convened in. --ledger mirrors events to a JSONL file too.
  for (const seat of configs) {
    seat.launchId = randomUUID();
    seat.nativeId = seat.resumeId || (seat.agent === 'claude' ? seat.launchId : null);
  }
  const savedSeat = ({ seat, agent, model, effort, bypass, nativeId, attention, handoff, handoffFrom, handoffTo }) => ({ seat, agent, model, effort, bypass, nativeId, attention, handoff, handoffFrom, handoffTo });
  let recordingChanged = () => {};
  const ledger = await openLedger({ cwd, seats: configs.map(savedSeat), mirror: options.ledger, name: options.name || previous?.name, resumedFrom: previous?.id,
    onRecordingHealth(health) { state.recordingWarning = recordingWarning(health); recordingChanged(); },
  });
  const record = ledger.record;
  const attention = createAttentionTracker(state.seats, (index, snapshot, cause) => ledger.attention(index, snapshot, cause));

  // Codex rollout attribution needs --no-daemon (agents.mjs) and a per-seat
  // originator override; claude transcripts need a pre-assigned session id.
  let noDaemon = state.seats.some(seat => seat.agent === 'codex') ? await withLoading('Preparing agents…', () => codexSupportsNoDaemon()) : false;
  const terms = [], procs = [];
  const candidates = new Set(), handoffAbort = new AbortController();
  let handoffs;
  let shuttingDown = false;
  // A failed launch must release every process started earlier in the lineup.
  const emergencyCleanup = () => {
    shuttingDown = true;
    handoffs?.stop(); handoffAbort.abort();
    for (const proc of candidates) { try { proc.kill(); } catch { } }
    state.seats.forEach((seat, index) => { try { attention.dispatch(index, { type: 'stopped' }); } catch { } });
    for (const seat of state.seats) seat.watcher?.stop();
    for (const proc of procs) { try { proc?.kill(); } catch { } }
    try { ledger.close(); } catch { }
    try { process.stdin.setRawMode(false); } catch { }
    if (state.recordingWarning) process.stderr.write(`${state.recordingWarning}\nLedger: ${ledger.file}\n`);
  };
  process.once('exit', emergencyCleanup);
  const wiredTerminals = new WeakSet();
  const wireTerminalReplies = (terminal, proc) => {
    if (wiredTerminals.has(terminal)) return;
    wiredTerminals.add(terminal);
    // Native CLIs and ConPTY query the terminal (cursor position, attributes).
    // Replies belong to this child, even while its pane is not visible.
    terminal.onData(data => {
      if (!shuttingDown && (procs.includes(proc) || candidates.has(proc))) proc.write(data);
    });
  };
  const attachSeat = (index, seat, terminal, proc) => {
    terms[index] = terminal; procs[index] = proc;
    attention.dispatch(index, { type: 'started' });
    wireTerminalReplies(terminal, proc);
    const scrub = makeWin32InputScrub();
    proc.onData(raw => {
      const index = state.seats.indexOf(seat);
      if (index < 0 || procs[index] !== proc) return;
      const data = scrub(raw);
      seat.lastOutput = Date.now();
      const screenVersion = seat.nativeOutputVersion = (seat.nativeOutputVersion || 0) + 1;
      terminal.write(data, () => {
        seat.nativeScreenVersion = screenVersion;
        observeNativeScreen(seat, terminal);
        const current = state.seats.indexOf(seat); if (current >= 0) schedulePaint(current);
      });
    });
    proc.onExit(async ({ exitCode }) => {
      let index = state.seats.indexOf(seat);
      if (shuttingDown || index < 0 || seat.stopping || procs[index] !== proc) return;
      seat.alive = false; procs[index] = null;
      await seat.watcher?.finish();
      index = state.seats.indexOf(seat);
      if (shuttingDown || index < 0 || seat.stopping) return;
      attention.dispatch(index, { type: 'exited', code: exitCode });
      seat.watcher?.stop();
      dispatchTable({ type: 'seat-died', seat: index, at: Date.now() });
      scheduleBar();
    });
    if (seat.agent === 'claude' || seat.agent === 'grok' || (seat.agent === 'codex' && (noDaemon || seat.resumeId))) {
      seat.watcher = createTurnWatcher({ agent: seat.agent, cwd, nativeId: seat.launchId, resumeId: seat.resumeId, boundary: seat.boundary, pid: proc.pid, onCache: observation => {
        if (!shuttingDown && state.seats.includes(seat)) acceptCacheObservation(seat.cache, observation);
      }, onEvent: event => { const current = state.seats.indexOf(seat); if (!shuttingDown && current >= 0) onTurnEvent(current, event); }, onIdentity: nativeId => {
        const index = state.seats.indexOf(seat);
        if (index < 0) return;
        seat.nativeId = nativeId;
        ledger.updateSeat(index, { nativeId });
      } });
    }
  };
  const commandFor = (seat, extra = {}) => terminalCommand(seat.agent, {
    model: seat.model, effort: seat.effort === 'default' ? undefined : seat.effort, bypass: seat.bypass,
    nativeId: seat.agent === 'claude' ? seat.nativeId : undefined, resumeId: seat.resumeId,
    noDaemon: seat.agent === 'codex' && noDaemon, ...extra,
  });
  const envFor = seat => {
    const childEnv = seatPermissionEnvironment(seat, seat.agent === 'codex' ? { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: `mrmak_chat_${seat.launchId}` } : env);
    seat.cache = newCacheState(resolveBilling(seat.agent, childEnv));
    return childEnv;
  };
  for (const [index, seat] of state.seats.entries()) {
    try {
      const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 3000, allowProposedApi: true });
      const command = commandFor(seat);
      const proc = pty.spawn(command.file, command.args, ptyOptions({ cwd, env: envFor(seat), cols: 80, rows: 24 }));
      attachSeat(index, seat, terminal, proc);
    } catch (error) {
      attention.dispatch(index, { type: 'launch-failed' });
      throw error;
    }
  }

  let readingTranscript = false;
  const visible = index => !readingTranscript && state.view !== 'table' && index === state.focus;
  const elapsed = seat => seat.turnStart ? (Date.now() - seat.turnStart) / 1000 : 0;
  let barTimer = null, paintTimers = state.seats.map(() => null);

  const drawBar = () => {
    barTimer = null;
    if (state.view === 'table' || state.usageOpen || readingTranscript) return;
    process.stdout.write(`\x1b[?25l\x1b7\x1b[${process.stdout.rows};1H\x1b[0m\x1b[2K${renderStatus(state, process.stdout.columns)}\x1b8` + placeCursor());
  };
  const scheduleBar = () => { if (!barTimer) barTimer = setTimeout(drawBar, 100); };
  recordingChanged = scheduleBar;
  let noticeTimer = null, clipboardBusy = false, draftGeneration = 0;
  const notice = text => {
    state.interactionNotice = String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
    clearTimeout(noticeTimer); scheduleBar();
    noticeTimer = setTimeout(() => { state.interactionNotice = null; scheduleBar(); }, 12000);
    noticeTimer.unref?.();
  };
  const placeCursor = () => {
    if (state.composer) return '';
    const region = regions[state.focus];
    if (!region) return '\x1b[?25l';
    const position = cursorPosition(terms[state.focus], region);
    return position ? `\x1b[${position.row};${position.column}H\x1b[?25h` : '\x1b[?25l';
  };
  const selectionFor = index => state.selection?.seat === index ? state.selection : null;
  const schedulePaint = index => {
    if (paintTimers[index] || !visible(index)) return;
    paintTimers[index] = setTimeout(() => {
      paintTimers[index] = null;
      if (!visible(index) || state.composer || state.usageOpen) return;
      process.stdout.write('\x1b[?25l' + paintContent(terms[index], regions[index], selectionFor(index)) + placeCursor());
      scheduleBar();
    }, 50);
  };
  const drawComposer = () => {
    const { out, cursor } = paintComposer({
      width: frame().surface.width, usableRows: usableRows(), seats: state.seats,
      targets: state.composer.targets, text: state.composer.text,
      colorOf: seat => color(seat.color), wrap: wrapText,
    });
    process.stdout.write(offsetSurface(out.replace(/\x1b\[0K/g, ''), frame().surface) + `\x1b[${cursor.row + 1};${cursor.column + 1 + frame().surface.x}H\x1b[?25h`);
  };
  const paintAll = () => {
    regions = layoutRegions();
    let out = '\x1b[?25l\x1b[0m\x1b[2J';
    for (const [index] of state.seats.entries()) {
      if (!visible(index)) continue;
      out += paintContent(terms[index], regions[index], selectionFor(index));
    }
    out += shelf();
    process.stdout.write(out);
    drawBar();
    if (state.composer) drawComposer();
  };
  const applyLayout = () => {
    if (readingTranscript) return;
    process.stdout.write(STATION_MOUSE);
    regions = layoutRegions();
    for (const [index] of state.seats.entries()) {
      const region = frame().surface;
      const size = inner(region);
      if (terms[index].cols !== size.width || terms[index].rows !== size.height) {
        procs[index]?.resize(size.width, size.height);
        terms[index].resize(size.width, size.height);
      }
    }
    if (state.usageOpen) { openUsage(); return; }
    if (state.view === 'table') { paintTable(); return; }
    paintAll();
  };

  // The state engine: a quiet working seat is either done (ready) or sitting
  // on a native approval menu (needs you) — the Phase 3 prompt detector reads
  // the seat's screen to tell them apart.
  const screenText = terminal => {
    const buffer = terminal.buffer.active;
    const lines = [];
    for (let row = 0; row < terminal.rows; row++) lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) || '');
    return lines.join('\n');
  };
  const tick = setInterval(() => {
    const now = Date.now();
    for (const [index, seat] of state.seats.entries()) {
      if (!seat.alive) continue;
      seat.watcher?.health();
      if (!readingTranscript && !state.composer && !state.usageOpen) {
        const reminder = cacheReminder(seat, cacheReminders, now);
        if (reminder) notice(reminder);
      }
      // Screen evidence can detect an approval, including startup trust menus.
      // It cannot declare a completed turn or acknowledge unread answers.
      if (seat.localCommand) continue; // A local information menu is not a model approval or a turn.
      const prompt = terminalPrompt(screenText(terms[index]));
      if (prompt && (seat.attention.activity !== 'completed' || seat.lastOutput > seat.attention.lastCompletedAt)) attention.dispatch(index, { type: 'prompt', id: prompt.id, kind: /allow|approv|permission|trust/i.test(prompt.question) ? 'approval' : 'choice', at: now });
      else if (seat.attention.waitReason === 'prompt') attention.dispatch(index, { type: 'prompt-cleared', at: now });
      else if (now - seat.lastOutput > 2000) {
        attention.dispatch(index, { type: 'quiet', native: !!seat.watcher, at: now });
      }
    }
    if (!state.composer && !readingTranscript) {
      if (state.usageOpen) paintUsage(usageSnapshot);
      else if (state.view === 'table') paintTable();
      else process.stdout.write('\x1b[?25l' + shelf() + placeCursor());
    }
    scheduleBar();
  }, 1000);

  const deliver = (index, text, { valid = () => true, capture, onSubmit, bootstrap = false } = {}) => {
    const proc = procs[index], seat = state.seats[index];
    return guardedDelivery({ seat, proc, text, capture,
      freshReady: bootstrap ? () => freshPromptReady(seat.agent, terms[index]) : null,
      // Codex's native paste handler can still be settling a multi-line draft
      // at 500 ms. Wait for its output to settle before the final readiness
      // check; never retry Enter after a missing native submission.
      ...(seat.agent === 'codex' ? { wait: async () => {
        const started = Date.now();
        do { await new Promise(resolve => setTimeout(resolve, 100)); }
        while (Date.now() - started < 5000 || Date.now() - seat.lastOutput < 500 && Date.now() - started < 8000);
      } } : {}),
      current: () => !shuttingDown && state.seats[index] === seat && procs[index] === proc && !!proc && valid(),
      prompt: () => terminalPrompt(screenText(terms[index])), refresh: async () => {
        await seat.watcher?.refresh();
        // Input guards inspect the live screen after queued parser writes,
        // regardless of where the user has scrolled the visible viewport.
        await new Promise(resolve => terms[index].write('', resolve));
      },
      onSubmit(request) { attention.dispatch(index, { type: 'submitted' }); seat.watcher?.expectProgress(); onSubmit?.(request); },
    });
  };
  const send = async (targets, text) => {
    const indices = targets === 'all' ? state.seats.map((seat, index) => seat.alive ? index : -1).filter(index => index >= 0) : targets;
    const sent = [];
    for (const index of indices) {
      try { await deliver(index, text); sent.push(state.seats[index].seat); }
      catch (error) { if (!shuttingDown) notice(`Delivery blocked for ${state.seats[index]?.seat}: ${error.message}`); }
    }
    if (sent.length && !shuttingDown) record({ type: 'chair', to: sent, text });
  };

  // ── Table driver: the impure half of station-table.mjs ──
  let table = null, tableGeneration = 0;
  const tableUI = { input: '', scroll: 0, waitMinutes: 15 };
  let tableNotice = null;
  const requests = {}, turnTimers = {};
  // Per-turn limit (§5: a stuck seat never holds the table). Alt+-/= steps
  // it while in table view; a change re-times outstanding turns from their
  // original sentAt, with a short grace if the new limit is already past.
  const WAIT_STEPS = [5, 10, 15, 30, 45, 60];
  let waitStep = 2;
  const turnWait = () => WAIT_STEPS[waitStep] * 60_000;
  const armTimeout = (seat, sentAt) => {
    clearTimeout(turnTimers[seat]);
    const owner = state.seats[seat], pending = table?.awaiting[seat];
    const current = () => !shuttingDown && owner === state.seats[seat] && owner?.alive && pending && table?.awaiting[seat] === pending && turnTimers[seat] === timer;
    const timer = setTimeout(async () => {
      if (!current()) return;
      // Wake-up can deliver the timeout before the history poll. Catch up and
      // consume an exact completed answer before deciding that time ran out.
      await collectAnswer(seat, { force: true });
      if (!current()) return;
      if (state.seats[seat]?.watcher?.health().state !== 'healthy') {
        blockTable(seat, 'Turn limit reached without verified native tracking. Inspect the seat before starting another table.'); return;
      }
      attention.dispatch(seat, { type: 'timeout' }); dispatchTable({ type: 'timeout', seat, at: Date.now() });
    }, Math.max(5_000, sentAt + turnWait() - Date.now()));
    turnTimers[seat] = timer; timer.unref?.();
  };
  const stepWait = direction => {
    waitStep = Math.min(WAIT_STEPS.length - 1, Math.max(0, waitStep + direction));
    tableUI.waitMinutes = WAIT_STEPS[waitStep];
    record({ type: 'table-turn-wait', minutes: WAIT_STEPS[waitStep] });
    if (table) for (const [seat, pending] of Object.entries(table.awaiting || {})) {
      if (turnTimers[seat]) armTimeout(Number(seat), pending.sentAt);
    }
    paintTable();
  };
  let usageSnapshot = null, usageScroll = 0;
  const paintUsage = usage => {
    if (!state.usageOpen) return;
    const region = frame().surface;
    const options = { seats: state.seats, usage, width: region.width, height: region.height, colorOf: seat => color(seat.color), focus: state.focus, cacheReminders };
    usageScroll = Math.min(usageScroll,Math.max(0,usageLines(options).length-region.height+1));
    process.stdout.write(shelf() + surfaceLines([], region) + offsetSurface(renderUsageModal({...options,scroll:usageScroll}), region));
  };
  const openUsage = () => {
    usageSnapshot = null;
    usageScroll = 0;
    paintUsage(null);
    Promise.all(state.seats.map(seat => seat.watcher ? seat.watcher.readUsage().catch(() => null) : Promise.resolve(null))).then(usage => { usageSnapshot = usage; paintUsage(usage); });
  };
  const paintTable = () => {
    if (state.view !== 'table' || state.usageOpen || readingTranscript) return;
    const region = frame().surface;
    const waiting = Object.keys(table?.awaiting || {}).map(Number).find(index => state.seats[index]?.attention?.watcher?.state === 'pending' && state.seats[index].attention.watcher.error);
    const waitingNotice = waiting === undefined ? null : `Waiting: ${state.seats[waiting].seat} · ${state.seats[waiting].attention.watcher.error}`;
    // Paint the footer first: renderTable owns the final cursor position.
    process.stdout.write('\x1b[?25l' + shelf() + `\x1b[${process.stdout.rows};1H\x1b[0m\x1b[2K` + renderStatus(state, process.stdout.columns) + renderTable({ table, ui: tableUI, seats: state.seats, width: region.width, height: region.height, x: region.x, colorOf: seat => color(seat.color), now: Date.now(), notice: tableNotice || waitingNotice, shelf: true }));
  };
  const dispatchTable = event => {
    if (!table && event.type !== 'table-start') return;
    if (event.type === 'table-start') tableGeneration++;
    const [next, effects] = tableReduce(table, event, state.seats);
    table = next;
    if (table?.phase === 'done') for (const timer of Object.values(turnTimers)) clearTimeout(timer);
    for (const effect of effects) {
      if (effect.type === 'send') {
        const index = effect.seat, seat = state.seats[index], generation = tableGeneration;
        const bootstrap = effect.round === 1 && freshSeatEligible(seat);
        const request = { id: randomUUID(), seat, pending: table.awaiting[index], submitted: false, signals: 0 };
        requests[index] = request;
        const text = `${effect.text}\n\nStation table request ${request.id}`;
        const valid = () => tableGeneration === generation && table?.phase !== 'done' && table?.awaiting[index] === request.pending && requests[index] === request;
        void (async () => {
          const delivery = await prepareTableDelivery({ agent: seat.agent, text, requestId: request.id, stationId: ledger.id });
          if (!valid() || shuttingDown) return;
          await deliver(index, delivery.text, { valid, bootstrap,
            async capture() { request.native = await seat.watcher.captureRequest(delivery.text, { bootstrap }); return request.native; },
            onSubmit() { request.submitted = true; },
          });
          if (!valid() || shuttingDown) return;
          record({ type: 'table-prompt', seat: seat.seat, round: effect.round, text, requestId: request.id,
            ...(delivery.file ? { deliveredText: delivery.text, requestFile: delivery.file, requestSha256: delivery.sha256 } : {}) });
          armTimeout(index, Date.now());
          void collectAnswer(index);
        })().catch(error => { if (!shuttingDown && valid()) blockTable(index, error.message, !request.submitted); });
      } else if (effect.type === 'ledger') record(effect.record);
    }
    paintTable();
  };
  const blockTable = (index, reason, retryable = false) => {
    if (!table || table.phase === 'done') return;
    tableNotice = `Table blocked: ${state.seats[index]?.seat || 'seat'} · ${reason}`;
    record({ type: 'table-blocked', seat: state.seats[index]?.seat, reason });
    clearTimeout(turnTimers[index]);
    dispatchTable(retryable ? { type: 'hold', seat: index, reason, at: Date.now() } : { type: 'end', reason: 'blocked', at: Date.now() });
    notice(tableNotice);
  };
  const collectAnswer = (index, { force = false } = {}) => {
    const request = requests[index];
    const valid = () => !shuttingDown && table?.phase !== 'done' && table?.awaiting[index] === request?.pending && requests[index] === request && state.seats[index] === request?.seat;
    if (!request?.submitted || !valid()) return;
    if (request.checking) return request.checking;
    if (!force && !request.signals) return;
    request.checking = Promise.resolve().then(async () => {
      do {
        const signals = request.signals;
        const answer = await request.seat.watcher.readResponse(request.native);
        if (!valid()) return;
        if (answer) {
          clearTimeout(turnTimers[index]);
          record({ type: 'table-response-match', seat: request.seat.seat, requestId: request.id, userId: answer.userId, answerId: answer.answerId, turnId: answer.turnId });
          dispatchTable({ type: 'answer', seat: index, text: answer.text, at: Date.now(), chairInterleaved: request.interleaved || undefined });
          return;
        }
        if (request.signals === signals) return;
      } while (valid());
    }).catch(error => { if (valid()) blockTable(index, error.message); }).finally(() => { request.checking = null; });
    return request.checking;
  };
  const onTurnEvent = (index, event) => {
    const seat = state.seats[index];
    if (event.kind === 'watcher-state') {
      if (shuttingDown) return;
      if (event.state === 'stopped' && seat.alive && !seat.stopping) event = { ...event, state: 'error', error: 'Native watcher stopped while its agent is running.' };
      attention.dispatch(index, { type: 'watcher-state', state: event.state, error: event.error });
      if (event.state === 'error' && table?.members.includes(index)) blockTable(index, event.error);
      if (event.state === 'healthy') void collectAnswer(index);
    }
    else if (event.kind === 'turn-started') attention.dispatch(index, { type: 'turn-started' });
    else if (event.kind === 'turn-interrupted') attention.dispatch(index, { type: 'interrupted' });
    else if (event.kind === 'attention') attention.dispatch(index, { type: 'error', code: 'provider-error', providerCode: event.providerCode });
    else if (event.kind === 'completed') {
      const id = `${event.nativeId || seat.nativeId}:${event.id || `${seat.launchId}:${event.version}`}`;
      if (!attention.dispatch(index, { type: 'completed', id })) return;
      if (shuttingDown) return;
      if (requests[index]) { requests[index].signals++; void collectAnswer(index); }
    }
    scheduleBar();
    if (state.view === 'table') paintTable();
  };
  handoffs = new StationHandoffs({
    cwd, getSeat: index => state.seats[index], tableActive: () => !!table && table.phase !== 'done',
    persist(index, job) { ledger.updateSeat(index, { handoff: job }); state.seats[index].handoff = job; scheduleBar(); },
    async submit(index, text) {
      if (terminalPrompt(screenText(terms[index]))) throw new Error('Resolve the agent menu before requesting a handoff.');
      await deliver(index, text);
      record({ type: 'handoff-request', seat: state.seats[index].seat });
    },
    async launch(index, job) {
      const source = state.seats[index], originalProcess = procs[index], originalTerminal = terms[index];
      if (!source.alive || source.nativeId !== job.sourceNativeId) throw new Error('The original seat is no longer available.');
      if (source.agent === 'codex' && !noDaemon) throw new Error('Fresh Codex handoff needs --no-daemon support to capture the new conversation.');
      const baseline = source.attention.completionVersion;
      const next = { ...decorateSeats([{ agent: source.agent, model: source.model, effort: source.effort, mode: source.mode }])[0], seat: source.seat, color: source.color, launchId: randomUUID(), attention: initialAttention() };
      next.nativeId = next.agent === 'claude' ? next.launchId : null;
      const terminal = new Terminal({ cols: terms[index].cols, rows: terms[index].rows, scrollback: 3000, allowProposedApi: true });
      const command = commandFor(next, { initialPrompt: continuationPrompt(job.file), readDir: path.dirname(job.file) });
      const proc = pty.spawn(command.file, command.args, ptyOptions({ cwd, env: envFor(next), cols: terminal.cols, rows: terminal.rows }));
      candidates.add(proc);
      wireTerminalReplies(terminal, proc);
      let exited = false, adopted = false, temporary;
      const exitSubscription = proc.onExit(() => { exited = true; });
      try {
        const scrub = makeWin32InputScrub();
        temporary = await waitForContinuation(proc, { signal: handoffAbort.signal, onData: raw => terminal.write(scrub(raw)) });
        if (shuttingDown || exited) throw new Error('The continuation stopped before it could be opened.');
        if (state.seats[index] !== source || source.nativeId !== job.sourceNativeId || !source.alive || source.attention.completionVersion !== baseline || ['working', 'waiting', 'failed'].includes(source.attention.activity) || (table && table.phase !== 'done')) throw new Error('The original changed while the continuation was starting. It is unchanged; review it before retrying.');
        const link = ledger.continueSeat(index, savedSeat(next), job);
        next.handoffFrom = link;
        source.stopping = true; source.watcher?.stop();
        temporary.dispose();
        state.seats[index] = next;
        attachSeat(index, next, terminal, proc);
        adopted = true;
        state.selection = null;
        try { originalProcess?.kill(); } catch { }
        originalTerminal.dispose();
        applyLayout();
        return link;
      } finally {
        candidates.delete(proc); exitSubscription.dispose(); temporary?.dispose();
        if (!adopted) { try { proc.kill(); } catch { } terminal.dispose(); }
      }
    },
  });
  let seatBusy = false;
  const resetRosterUI = () => {
    paintTimers.forEach(clearTimeout); paintTimers = state.seats.map(() => null);
    for (const key of Object.keys(turnTimers)) { clearTimeout(turnTimers[key]); delete turnTimers[key]; }
    for (const key of Object.keys(requests)) delete requests[key];
    table = null; tableGeneration++;
    tableUI.input = ''; tableUI.scroll = 0; tableNotice = null;
    state.selection = null;
    if (state.view === 'table') state.view = 'console';
    draftGeneration++;
  };
  const stopSeat = async (index, seat) => {
    const proc = procs[index];
    seat.stopping = true;
    try {
      if (proc) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { subscription.dispose(); reject(new Error('The agent has not stopped yet. Wait before retrying.')); }, 10000);
        const subscription = proc.onExit(() => { clearTimeout(timer); subscription.dispose(); resolve(); });
        try { proc.kill(); } catch (error) { clearTimeout(timer); subscription.dispose(); reject(error); }
      });
      if (shuttingDown) throw new Error('Rellin is closing.');
      seat.alive = false; procs[index] = null;
      await seat.watcher?.finish();
      seat.watcher?.stop();
      attention.dispatch(index, { type: 'stopped' });
    } finally { seat.stopping = false; }
  };
  const operateSeat = async (operation, index, config) => {
    seatMutationGuard({ count: state.seats.length, operation, tableActive: !!table && table.phase !== 'done', handoffPending: handoffs.pending.size > 0, busy: seatBusy || clipboardBusy });
    seatBusy = true;
    try {
      const source = state.seats[index];
      if (operation === 'close') {
        await stopSeat(index, source);
        if (shuttingDown) return;
        ledger.removeSeat(index);
        const terminal = terms[index];
        state.seats.splice(index, 1); terms.splice(index, 1); procs.splice(index, 1);
        Object.assign(state, removedSeatNavigation(state, index, state.seats.length));
        resetRosterUI(); terminal.dispose(); notice(`${source.seat} closed · conversation saved in history`);
        return;
      }
      let resume;
      if (operation === 'restart') {
        // Validate the saved conversation before interrupting its process.
        if (source.nativeId) await prepareResume({ cwd, seats: [savedSeat(source)] });
        await stopSeat(index, source);
        if (shuttingDown) return;
        if (source.nativeId) [resume] = await prepareResume({ cwd, seats: [savedSeat(source)] });
        config = { agent: source.agent, model: source.model, effort: source.effort, mode: source.bypass ? 'auto' : 'manual' };
      }
      if (config.agent === 'codex' && !noDaemon) noDaemon = await codexSupportsNoDaemon();
      if (shuttingDown) return;
      const next = { ...decorateSeats([config])[0], ...resume, launchId: randomUUID(), attention: initialAttention(operation === 'restart' ? source.attention : undefined) };
      if (operation === 'restart') {
        next.seat = source.seat; next.color = source.color;
        next.handoffFrom = source.handoffFrom; next.handoffTo = source.handoffTo;
      } else {
        next.seat = nextSeatName(next.agent, state.seats);
        next.color = nextSeatAccent(next.agent, state.seats);
      }
      next.nativeId = next.resumeId || (next.agent === 'claude' ? next.launchId : null);
      const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 3000, allowProposedApi: true });
      let proc, temporary, exitSubscription, adopted = false, exited = false;
      try {
        const command = commandFor(next);
        proc = pty.spawn(command.file, command.args, ptyOptions({ cwd, env: envFor(next), cols: terminal.cols, rows: terminal.rows }));
        candidates.add(proc);
        wireTerminalReplies(terminal, proc);
        exitSubscription = proc.onExit(() => { exited = true; });
        const scrub = makeWin32InputScrub();
        temporary = await waitForContinuation(proc, { signal: handoffAbort.signal, onData: raw => terminal.write(scrub(raw)), label: 'agent', failureNote: operation === 'restart' ? 'The seat is stopped; its saved conversation is retained. Retry to resume it.' : 'No seat was added.' });
        if (shuttingDown || exited) throw new Error('The agent stopped before it could be opened.');
        const nextSeats = operation === 'add' ? [...state.seats, next] : state.seats.map((seat, i) => i === index ? next : seat);
        ledger.changeSeats(nextSeats.map(savedSeat), { type: operation === 'add' ? 'seat-added' : 'seat-restarted', seat: next.seat, nativeId: next.nativeId });
        temporary.dispose();
        if (operation === 'add') { index = state.seats.length; state.seats.push(next); }
        else { state.seats[index] = next; terms[index].dispose(); }
        attachSeat(index, next, terminal, proc); adopted = true;
        state.focus = index; resetRosterUI(); notice(`${next.seat} ${operation === 'add' ? 'added' : 'restarted'}`);
      } finally {
        candidates.delete(proc); exitSubscription?.dispose(); temporary?.dispose();
        if (!adopted) { try { proc?.kill(); } catch { } terminal.dispose(); }
      }
    } finally { seatBusy = false; }
  };
  let admitting = false;
  const handleTableKey = async chunk => {
    if (admitting) return;
    // Raw input may coalesce repeated Backspaces with adjacent typed text.
    // Preserve each edit rather than turning the control bytes into spaces.
    if (!chunk.startsWith('\x1b') && chunk.length > 1 && /[\x08\x7f\r]/.test(chunk)) {
      for (const part of chunk.match(/[^\x08\x7f\r]+|[\x08\x7f\r]/gu)) await handleTableKey(part);
      return;
    }
    tableNotice = null;
    if (chunk === '\r') {
      const input = tableUI.input.trim();
      if (table?.phase === 'held') {
        if (input) { tableUI.input = ''; dispatchTable({ type: 'interject', text: input, at: Date.now() }); }
        admitting = true;
        try {
          for (const index of Object.keys(table.held).map(Number)) {
            const seat = state.seats[index];
            await seat.watcher?.refresh();
            const problem = readinessProblem(seat, { prompt: terminalPrompt(screenText(terms[index])), fresh: table.round === 1 && freshPromptReady(seat.agent, terms[index]) });
            if (problem) { tableNotice = `Still held: ${seat.seat} · ${problem}`; paintTable(); return; }
          }
          dispatchTable({ type: 'retry', at: Date.now() });
        } catch (error) { tableNotice = `Cannot retry: ${error.message}`; paintTable(); }
        finally { admitting = false; }
        return;
      }
      if (!table || table.phase === 'done') {
        if (!input) return;
        const members = state.seats.map((seat, index) => seat.alive ? index : -1).filter(index => index >= 0);
        if (members.length < 2) { tableNotice = 'A table needs two running seats with healthy native tracking.'; paintTable(); return; }
        if (handoffs.pending.size || seatBusy) { tableNotice = 'Finish handoffs and seat changes before convening a table.'; paintTable(); return; }
        const lineup = [...state.seats];
        admitting = true;
        try {
          await Promise.all(members.map(index => lineup[index].watcher?.refresh()));
          if (shuttingDown || lineup.length !== state.seats.length || lineup.some((seat, index) => state.seats[index] !== seat)) return;
          for (const index of members) {
            const problem = readinessProblem(state.seats[index], { prompt: terminalPrompt(screenText(terms[index])), fresh: freshPromptReady(state.seats[index].agent, terms[index]) });
            if (problem) { tableNotice = `Cannot convene: ${state.seats[index].seat} · ${problem}`; paintTable(); return; }
          }
        } catch (error) { tableNotice = `Cannot convene: ${error.message}`; paintTable(); return; }
        finally { admitting = false; }
        if (tableUI.input.trim() !== input) return;
        tableUI.input = ''; tableUI.scroll = 0;
        dispatchTable({ type: 'table-start', topic: input, members, maxRounds: 3, at: Date.now() });
        return;
      }
      if (input) { tableUI.input = ''; dispatchTable({ type: 'interject', text: input, at: Date.now() }); return; }
      if (table.phase === 'paused') { dispatchTable({ type: 'resume', at: Date.now() }); return; }
      paintTable();
    } else if (chunk === ' ' && !tableUI.input) dispatchTable({ type: 'pause' });
    else if (chunk === '\x1b=' || chunk === '\x1b+') stepWait(1);
    else if (chunk === '\x1b-' || chunk === '\x1b_') stepWait(-1);
    else if (chunk === '\x15') { tableUI.input = ''; paintTable(); }
    else if (chunk === '\x7f' || chunk === '\b') { tableUI.input = graphemes(tableUI.input).slice(0, -1).join(''); paintTable(); }
    else if (chunk === '\x1b[5~') { tableUI.scroll += 5; paintTable(); }
    else if (chunk === '\x1b[6~') { tableUI.scroll = Math.max(0, tableUI.scroll - 5); paintTable(); }
    else if (chunk[0] !== '\x1b' || chunk.startsWith('\x1b[200~')) {
      const text = chunk.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');
      if (text) { tableUI.input += text; paintTable(); }
    }
  };
  const quit = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    handoffs.stop(); handoffAbort.abort();
    for (const proc of candidates) { try { proc.kill(); } catch { } }
    clearInterval(tick);
    clearTimeout(noticeTimer);
    for (const timer of Object.values(turnTimers)) clearTimeout(timer);
    let closeError;
    try { await Promise.all(state.seats.map(seat => seat.watcher?.finish())); } catch (error) { closeError = error; }
    state.seats.forEach((seat, index) => {
      try { attention.dispatch(index, { type: 'stopped' }); } catch (error) { closeError ||= error; }
    });
    for (const proc of procs) proc?.kill();
    try { ledger.close(); } catch (error) { closeError = error; }
    process.removeListener('exit', emergencyCleanup);
    process.stdin.setRawMode(false);
    closeScreen();
    if (state.recordingWarning) process.stderr.write(`${state.recordingWarning}\nLedger: ${ledger.file}\n`);
    if (closeError) process.stderr.write(`Rellin could not finish saving: ${String(closeError.message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')}\n`);
    process.exit(closeError ? 1 : 0);
  };

  // Rellin-owned selection: terminal-native selection spans visual rows
  // across every pane, so drag-to-copy must live in the compositor. Text is
  // extracted from the seat's own buffer (wrapped lines joined) and copied
  // via OSC 52. A plain click focuses the pane.
  const paneHit = (x, y) => regions.findIndex(region => region && x - 1 >= region.x && x - 1 < region.x + region.width && y - 1 >= region.y && y - 1 < region.y + region.height);
  const bufferPoint = (index, x, y) => {
    const region = inner(regions[index]);
    const clamp = (value, max) => Math.max(0, Math.min(value, max));
    return {
      col: clamp(x - 1 - region.x, region.width - 1),
      row: terms[index].buffer.active.viewportY + clamp(y - 1 - region.y, region.height - 1),
    };
  };
  let copyBusy = false;
  const copySelection = async () => {
    if (copyBusy || !state.selection?.moved) return;
    const text = selectionText(terms[state.selection.seat], state.selection);
    if (!text) { notice('No text selected.'); return; }
    copyBusy = true;
    try { const result = await copyClipboard(text); if (!shuttingDown) notice(result); }
    catch (error) { if (!shuttingDown) notice(`Copy failed: ${error.message}`); }
    finally { copyBusy = false; }
  };
  const resizeShelf = createShelfDrag();
  const onMouse = event => {
    if (resizeShelf(event, process.stdout.columns, process.stdout.rows)) {
      state.selection = null;
      applyLayout();
      return;
    }
    if (state.composer || state.usageOpen) return;
    if (event.kind === 'press') {
      const hit = shelfActionAt(frame().shelf,state.seats,state.focus,event.x-1,event.y-1);
      if (hit) { state.focus = hit.index; state.view = 'console'; state.selection = null; applyLayout(); return hit.key; }
      if (state.view === 'table') return;
      const index = paneHit(event.x, event.y);
      if (index < 0) return;
      const content = inner(regions[index]);
      if (event.x - 1 < content.x || event.x - 1 >= content.x + content.width || event.y - 1 < content.y || event.y - 1 >= content.y + content.height) return;
      // Hit-test before changing focus: a zoom layout can move the clicked pane.
      const point = bufferPoint(index, event.x, event.y);
      const link = event.ctrl ? terminalLinkAt(terms[index], point.row, point.col, cwd) : null;
      if (index !== state.focus) { state.focus = index; state.selection = null; applyLayout(); }
      state.selection = { seat: index, anchorRow: point.row, anchorCol: point.col, headRow: point.row, headCol: point.col, moved: false, link };
      return;
    }
    if (!state.selection || state.view === 'table') return;
    const point = bufferPoint(state.selection.seat, event.x, event.y);
    if (event.kind === 'drag') {
      state.selection = { ...state.selection, headRow: point.row, headCol: point.col, moved: true };
      schedulePaint(state.selection.seat);
      return;
    }
    // Release: a drag copies and keeps its highlight; a plain click only
    // focused, so the selection clears.
    if (state.selection.link && !state.selection.moved) {
      const link = state.selection.link;
      state.selection = null;
      void activateLink(link).then(result => { if (!shuttingDown) notice(result.notice); }, error => { if (!shuttingDown) notice(`Could not open link: ${error.message}`); });
    } else if (state.selection.moved) {
      void copySelection();
    } else {
      state.selection = null;
    }
    schedulePaint(state.selection?.seat ?? state.focus);
  };

  // Wheel over a pane scrolls like a real terminal: normal buffer → the
  // seat's scrollback moves locally (viewportY feeds paintContent, so the
  // pane follows); alternate buffer (full-screen TUIs own their scrollback)
  // → forward as SGR wheel reports if the app asked for mouse tracking,
  // else as arrow keys — the alternate-scroll convention terminals use.
  const wheelPane = event => {
    const index = paneHit(event.x, event.y);
    if (index < 0 || !procs[index]) return;
    const terminal = terms[index];
    const up = event.delta > 0;
    const tracking = terminal.modes?.mouseTrackingMode ?? 'none';
    if (tracking !== 'none' && tracking !== 'x10') {
      // X10 is press-only — wheel reports would corrupt its input stream.
      const region = inner(regions[index]);
      const col = Math.max(1, Math.min(event.x - region.x, region.width));
      const row = Math.max(1, Math.min(event.y - region.y, region.height));
      procs[index].write(`\x1b[<${up ? 64 : 65};${col};${row}M`.repeat(3));
    } else if (terminal.buffer.active.type === 'alternate') {
      procs[index].write((up ? '\x1b[A' : '\x1b[B').repeat(3));
    } else {
      terminal.scrollLines(up ? -3 : 3);
      schedulePaint(index);
    }
  };

  process.stdout.on('resize', applyLayout);
  let tablePaste = null;
  const onInput = async chunk => {
    if (readingTranscript || shuttingDown) return;
    if (state.view !== 'table' || state.composer) tablePaste = null;
    else if (tablePaste !== null || chunk.startsWith('\x1b[200~')) {
      tablePaste = (tablePaste ?? '') + chunk;
      const end = tablePaste.indexOf('\x1b[201~');
      if (tablePaste.length > 128000) { tablePaste = null; tableNotice = 'Paste is too long; use a document path for large context.'; paintTable(); return; }
      if (end < 0) return;
      const pasted = tablePaste.slice(0, end + 6), trailing = tablePaste.slice(end + 6);
      tablePaste = null;
      await handleTableKey(pasted);
      if (trailing) await onInput(trailing);
      return;
    }
    if (state.usageOpen && ['\x1b[A','\x1b[B','\x1b[5~','\x1b[6~'].includes(chunk)) {
      usageScroll = Math.max(0,Math.min(1000,usageScroll + ({'\x1b[A':-1,'\x1b[B':1,'\x1b[5~':-10,'\x1b[6~':10}[chunk])));
      paintUsage(usageSnapshot);return;
    }
    if (state.usageOpen && (chunk === 'r' || chunk === 's')) {
      if (chunk === 'r') {
        cacheReminders = !cacheReminders;
        try { saveCacheReminders(cacheReminders); } catch { notice('Cache reminder preference could not be saved.'); }
      } else if (state.seats[state.focus]?.cache) state.seats[state.focus].cache.snoozeUntil = Date.now() + 600000;
      paintUsage(usageSnapshot); return;
    }
    if (/\x1b\[</.test(chunk)) {
      for (const event of parseMouse(chunk)) {
        if (event.kind === 'wheel') {
          if (state.usageOpen) { usageScroll = Math.max(0,usageScroll+event.delta); paintUsage(usageSnapshot); }
          else if (state.view === 'table') { tableUI.scroll = Math.max(0, tableUI.scroll + event.delta); paintTable(); }
          else wheelPane(event);
        }
        else { const key=onMouse(event); if(key) await onInput(key); }
      }
      return;
    }
    const action = keyAction(chunk, state);
    if (state.view === 'table' && !state.composer && action.type === 'passthrough') { handleTableKey(chunk); return; }
    const [next, effects] = reduce(state, action);
    if (!!state.composer !== !!next.composer || state.view !== next.view) draftGeneration++;
    state = next;
    for (const effect of effects) {
      if (effect.type === 'write') {
        if (state.selection) {
          const selectedSeat = state.selection.seat;
          state.selection = null; schedulePaint(selectedSeat);
        }
        const seat = state.seats[effect.to];
        const nativePrompt = !!terminalPrompt(screenText(terms[effect.to]));
        const { submitted, expectTurn } = observeNativeInput(seat, effect.data, { prompt: nativePrompt, terminal: terms[effect.to] });
        seat.inputVersion = (seat.inputVersion || 0) + 1;
        if (nativePrompt && seat.watcher?.canBootstrap?.()) seat.bootstrapInputVersion = seat.inputVersion;
        if (submitted || effect.data === '\x03') seat.draftDirty = false;
        else if (effect.data.startsWith('\x1b[200~') || !/[\x00-\x1f\x7f]/.test(effect.data)) seat.draftDirty = true;
        procs[effect.to]?.write(effect.data);
        // Typing into a scrolled-up pane snaps it back to the live bottom.
        if (terms[effect.to]?.buffer.active.viewportY !== terms[effect.to]?.buffer.active.baseY) { terms[effect.to]?.scrollToBottom(); schedulePaint(effect.to); }
        if (expectTurn && state.seats[effect.to].alive) {
          if (requests[effect.to]) requests[effect.to].interleaved = true;
          attention.dispatch(effect.to, { type: 'submitted' });
          seat.watcher?.expectProgress({ manual: true });
        }
      }
      else if (effect.type === 'copy-selection') void copySelection();
      else if (effect.type === 'layout') applyLayout();
      else if (effect.type === 'send') send(effect.targets, effect.text);
      else if (effect.type === 'tableEnd') { if (table && table.phase !== 'done') dispatchTable({ type: 'end', reason: 'chair', at: Date.now() }); }
      else if (effect.type === 'usageOpen') openUsage();
      else if (effect.type === 'clipboard') {
        if (clipboardBusy) continue;
        const intoTable = state.view === 'table' && !state.composer;
        const index = state.focus, seat = state.seats[index], proc = procs[index];
        const composing = !!state.composer, generation = draftGeneration;
        if (!intoTable && !composing && (!seat.alive || !proc || terminalPrompt(screenText(terms[index])))) { notice('Resolve the agent prompt or restart the stopped seat before pasting.'); continue; }
        clipboardBusy = true; notice('Reading clipboard…');
        try {
          const draft = await pasteClipboard();
          if (shuttingDown) continue;
          if (intoTable) {
            if (state.view !== 'table' || state.composer || generation !== draftGeneration) throw new Error('The table input closed. Paste again into the intended field.');
            if (draft.image) throw new Error('Paste images into an agent pane; the table accepts text.');
            tableUI.input += draft.text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');
            paintTable();
          } else if (composing) {
            if (!state.composer || generation !== draftGeneration) throw new Error('The draft changed or closed. Paste again into the intended chat.');
            state = { ...state, composer: { ...state.composer, text: state.composer.text + draft.text } };
            if (!readingTranscript) drawComposer();
          } else {
            if (state.seats[index] !== seat || procs[index] !== proc || !seat.alive || terminalPrompt(screenText(terms[index]))) throw new Error('The original seat changed or needs input. Paste again when it is ready.');
            proc.write(bracketedDraft(draft.text));
            observeNativeInput(seat, bracketedDraft(draft.text));
            seat.inputVersion = (seat.inputVersion || 0) + 1; seat.draftDirty = true;
          }
          const destination = intoTable ? 'table' : composing ? 'composer' : seat.seat;
          record({ type: 'clipboard-paste', seat: destination, image: draft.image || null });
          notice(draft.image ? `Image path added to ${destination} draft · add your message, then Enter` : `Text pasted into ${destination}`);
        } catch (error) { if (!shuttingDown) notice(`Paste failed: ${error.message}`); }
        finally { clipboardBusy = false; }
      }
      else if (effect.type === 'seats') {
        readingTranscript = true;
        const result = await showSeatManager({ getSeats: () => state.seats, focus: state.focus, operate: operateSeat,
          getOptions: async () => ({ available: inventory().filter(agent => agent.available && agent.id !== 'shell').map(agent => agent.id), ...await discoverOptions(process.env, cwd) }),
          redrawBackground() { readingTranscript = false; applyLayout(); readingTranscript = true; },
        });
        readingTranscript = false;
        if (result.quit) quit(); else applyLayout();
      }
      else if (effect.type === 'files') {
        readingTranscript = true;
        const seat = state.seats[state.focus];
        const result = await showFiles({ cwd, label: seatLabel(seat), read: () => readConversation(seat, cwd), redrawBackground() {
          readingTranscript = false; applyLayout(); readingTranscript = true;
        } });
        readingTranscript = false;
        if (result.quit) quit(); else applyLayout();
      }
      else if (effect.type === 'handoff') {
        readingTranscript = true;
        const result = await showHandoff({ manager: handoffs, index: state.focus, seat: state.seats[state.focus], redrawBackground() {
          readingTranscript = false;
          applyLayout();
          readingTranscript = true;
        } });
        readingTranscript = false;
        if (result.quit) quit();
        else applyLayout();
      }
      else if (effect.type === 'transcript') {
        readingTranscript = true;
        const result = await showConversation({ seats: state.seats, cwd, focus: state.focus, activateLink, frame: (index, token) => { state.focus = index; readerSnapshot = { seat: index, token }; return { region: frame().surface, chrome: shelf() }; }, acknowledge: (index, version) => attention.acknowledge(index, version) });
        readerSnapshot = null;
        readingTranscript = false;
        if (result.quit) quit();
        else applyLayout();
      }
      else if (effect.type === 'quit') quit();
    }
    if (state.composer) drawComposer();
  };
  process.stdin.on('data',onInput);

  // ?9001l first: a previous run may have left the tab in win32-input-mode.
  // Button-event mouse tracking (1002/1006) feeds the station's selection.
  process.stdout.write('\x1b[?9001l\x1b[?1002h\x1b[?1006h');
  applyLayout();
  } catch (error) { closeScreen(); throw error; }
}

// Realpath the entry: the global `station` shim invokes this file through
// npm's junction, and Node realpaths the ESM main module — the raw argv[1]
// would never match import.meta.url when linked.
const entry = process.argv[1] && (() => { try { return realpathSync(process.argv[1]); } catch { return path.resolve(process.argv[1]); } })();
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch(error => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[0m\x1b[?25h');
    }
    console.error(error.message || error);
    process.exit(1);
  });
}
