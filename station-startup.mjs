import path from 'node:path';
import { loadHistory, prepareResume } from './station-history.mjs';
import { loadPins, projectKey, recentProjects, resolveProject, savePins } from './station-projects.mjs';
import { showConversation } from './station-conversation.mjs';
import { cleanLabel, seatLabel, emphasizePosture } from './station-vocabulary.mjs';
import { consoleLayout, paintShelf, surfaceLines, createShelfDrag } from './station-view.mjs';
import { parseMouse } from './station-links.mjs';
import { seatAccent, accentColor } from './station-identity.mjs';
import { withLoading } from './station-screen.mjs';
import { recordingIssueLabel } from './station-ledger.mjs';

const safe = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export const runStatus = run => run.active ? 'active' : run.seats.length && run.seats.every(seat => ['claude', 'codex', 'grok'].includes(seat.agent) && seat.nativeId) ? 'saved' : 'legacy';

export function initialStartup(data) {
  const state = { page: 'projects', project: null, query: '', index: 0, edit: null, text: '', notice: null };
  const recent = data.runs.filter(run => projectKey(run.cwd) === projectKey(data.cwd) && runStatus(run) === 'saved').sort((a,b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
  if (!recent) return state;
  state.page = 'sessions'; state.project = data.cwd;
  state.index = startupItems(state, data).findIndex(run => run.id === recent.id);
  return state;
}

export function startupItems(state, data) {
  const query = state.query.toLowerCase();
  if (state.page === 'projects') return data.projects.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(query));
  return data.runs.filter(run => (!state.project || projectKey(run.cwd) === projectKey(state.project)) && `${run.name || ''} ${run.cwd} ${run.id} ${run.seats.map(seat => seat.agent).join(' ')}`.toLowerCase().includes(query));
}

export function startupKey(chunk, state) {
  if (chunk === 'v' && !state.edit) return { type: 'read' };
  if (['\x11', '\x03'].includes(chunk)) return { type: 'quit' };
  if (chunk === '\x1b') return { type: 'back' };
  if (state.edit) {
    if (chunk === '\r') return { type: 'submit' };
    if (['\x7f', '\b'].includes(chunk)) return { type: 'erase' };
    if (chunk.startsWith('\x1b[200~')) return { type: 'text', text: safe(chunk.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '')) };
    return /[\x00-\x1f\x7f-\x9f]/.test(chunk) ? { type: 'none' } : { type: 'text', text: chunk };
  }
  return ({ '\x1b[A': { type: 'move', delta: -1 }, '\x1b[B': { type: 'move', delta: 1 }, '\x1b[5~': { type: 'move', delta: -8 }, '\x1b[6~': { type: 'move', delta: 8 }, '\r': { type: 'open' }, '/': { type: 'edit', field: 'search' }, o: { type: 'edit', field: 'path' }, n: { type: 'new' }, p: { type: 'pin' }, h: { type: 'history' }, q: { type: 'quit' } })[chunk] || { type: 'none' };
}

export function startupReduce(state, action, data) {
  const items = startupItems(state, data), selected = items[state.index];
  const fresh = { ...state, notice: null };
  switch (action.type) {
    case 'read': return state.page === 'sessions' && selected ? [state, { type: 'read', run: selected }] : [state];
    case 'quit': return [state, { type: 'quit' }];
    case 'move': return [{ ...fresh, index: Math.max(0, Math.min(items.length - 1, state.index + action.delta)) }];
    case 'edit': return [{ ...fresh, edit: action.field, text: action.field === 'search' ? state.query : '' }];
    case 'text': {
      const text = (state.text + action.text).slice(0, state.edit === 'name' ? 120 : 1000);
      return [{ ...fresh, text, ...(state.edit === 'search' ? { query: text, index: 0 } : {}) }];
    }
    case 'erase': {
      const text = [...state.text].slice(0, -1).join('');
      return [{ ...fresh, text, ...(state.edit === 'search' ? { query: text, index: 0 } : {}) }];
    }
    case 'submit':
      if (state.edit === 'search') return [{ ...fresh, edit: null }];
      if (state.edit === 'path') return [state, { type: 'path', value: state.text }];
      if (state.edit === 'name') return [state, { type: 'new', cwd: state.newCwd, name: state.text.trim() || path.basename(state.newCwd) }];
      return [state];
    case 'back':
      if (state.edit) return [{ ...fresh, edit: null, ...(state.edit === 'search' ? { query: '', index: 0 } : {}) }];
      if (state.query) return [{ ...fresh, query: '', index: 0 }];
      if (state.page === 'sessions') return [{ ...fresh, page: 'projects', project: null, index: 0 }];
      return [state, { type: 'quit' }];
    case 'history': return [{ ...fresh, page: 'sessions', project: null, query: '', index: 0 }];
    case 'pin': return state.page === 'sessions' ? [{...fresh,page:'projects',project:null,index:0,query:''}]
      : selected ? [state, { type: 'pin', project: selected }] : [state];
    case 'new': {
      const cwd = state.page === 'projects' ? selected?.path : state.project || selected?.cwd || data.cwd;
      return cwd ? [{ ...fresh, edit: 'name', text: data.name || '', newCwd: cwd }] : [state];
    }
    case 'open':
      if (!selected) return [state];
      if (state.page === 'projects') return [{ ...fresh, page: 'sessions', project: selected.path, query: '', index: 0 }];
      if (runStatus(selected) !== 'saved') return [{ ...state, notice: runStatus(selected) === 'active' ? 'This run is active. Close it before resuming.' : 'This older run has no supported saved conversation IDs. Press n for a new session.' }];
      return [state, { type: 'resume', run: selected }];
    default: return [state];
  }
}

// A bounded, scrolling list works at small terminal sizes without wrapping rows.
export function renderStartup(state, data, width = 100, height = 30) {
  const items = startupItems(state, data), selected = items[state.index];
  const capacity = Math.max(1, height - 14), start = Math.floor(state.index / capacity) * capacity;
  const lines = [state.page === 'projects' ? ' Choose a project' : ' Continue a session', '', state.page === 'projects' ? ' Projects' : ` Sessions · ${state.project || 'all projects'}`, ` ${state.query ? `Filter: ${state.query}` : state.page === 'projects' ? 'Enter sessions · n new in selected folder' : 'Enter resumes · n new · Esc projects'}`, ''];
  if (state.returnToSetup) {
    lines[1]=' [ Back to setup ]';
    if (!state.query && state.page==='sessions') lines[3]=' Enter resumes · n new · p projects · Esc setup';
  }
  for (const [offset, item] of items.slice(start, start + capacity).entries()) {
    const mark = start + offset === state.index ? '>' : ' ';
    const tail = state.page === 'projects' ? ` · ${item.sessions} sessions` : ` · ${item.started_at.slice(5,16).replace('T',' ')}`;
    const prefix = state.page === 'projects' ? ` ${mark} ${item.pinned ? '*' : ' '} ` : ` ${mark} ${runStatus(item).padEnd(6)} `;
    const name = (item.recordingIssues?.length ? `[${recordingIssueLabel(item.recordingIssues)}] ` : '') + cleanLabel(item.name || path.basename(item.cwd || item.path));
    const room = Math.max(1, width - prefix.length - tail.length - 1);
    lines.push(prefix + (name.length > room ? name.slice(0,Math.max(0,room-1)) + '…' : name) + tail);
  }
  if (!items.length) lines.push(state.page === 'projects' ? ' No matching projects. Press o to enter a folder.' : ' No matching sessions. Press n to start one.');
  lines.push('', ` ${items.length ? `${state.index + 1}/${items.length}` : '0/0'}  ${selected?.path || selected?.cwd || ''}`);
  if (state.edit) lines.push(` ${ { search: 'Search', path: 'Folder path', name: 'Session name' }[state.edit]}: ${state.text}_`, ' Enter confirm · Esc cancel');
  else lines.push(state.page === 'projects' ? ' ↑↓ select · Enter sessions · n new · p pin' : ' ↑↓ select · Enter resume · v read · n new', ' / search · o folder · h all history', ' PgUp/PgDn scroll · Esc back · q quit');
  if (state.notice) lines.push(` ${state.notice}`);
  return lines.slice(0, Math.max(1, height)).map(line => emphasizePosture(safe(line).slice(0, Math.max(1, width - 1))));
}

export async function runStartup({ cwd, name, last = null, returnToSetup = false, manageScreen = true }) {
  const loaded = await withLoading('Loading saved sessions…', async () => {
    const pinned = await loadPins();
    const data = { cwd, name, runs: loadHistory(), projects: [] };
    data.projects = await recentProjects({ cwd, runs: data.runs, pinned });
    return {pinned,data};
  });
  let { pinned } = loaded;
  const { data } = loaded;
  let state = initialStartup(data);
  if (returnToSetup) state={...state,page:'sessions',project:cwd,returnToSetup:true};
  return new Promise(resolve => {
    let busy = false, closed = false;
    const resizeShelf = createShelfDrag();
    const draw = () => {
      if (closed) return;
      const { shelf, surface } = consoleLayout(process.stdout.columns, process.stdout.rows);
      const selected = startupItems(state,data)[state.index];
      const seats = state.page === 'sessions' && selected?.seats?.length ? selected.seats : last?.length ? last.map(seat => ({...seat, mode:'manual',bypass:false})) : [{empty:true},{empty:true}];
      const lines = renderStartup(state, data, surface.width, surface.height);
      process.stdout.write('\x1b[?25l' + paintShelf(shelf,seats,0,{mode:'setup',colorOf:seat=>accentColor(seatAccent(seats,seats.indexOf(seat)))}) + surfaceLines(lines,surface) + surfaceLines([''],{x:0,y:surface.height,width:process.stdout.columns,height:1}));
    };
    const finish = value => {
      closed = true;
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', draw);
      process.stdout.write('\x1b[?2004l' + (manageScreen ? '\x1b[?1002l\x1b[?1006l\x1b[?1049l\x1b[?25h' : ''));
      resolve(value);
    };
    const onData = async chunk => {
      if (busy) return;
      if (returnToSetup && chunk==='\x1b' && !state.edit && !state.query) return finish({back:true});
      if (String(chunk).includes('\x1b[<')) {
        for (const event of parseMouse(chunk)) {
          if (resizeShelf(event,process.stdout.columns,process.stdout.rows)) draw();
          else if (returnToSetup && event.kind==='press') {
            const {surface}=consoleLayout(process.stdout.columns,process.stdout.rows);
            if(event.y===2 && event.x>=surface.x+2 && event.x<=surface.x+18) return finish({back:true});
          }
        }
        return;
      }
      const [next, effect] = startupReduce(state, startupKey(chunk, state), data);
      state = next;
      if (!effect) { draw(); return; }
      busy = true;
      try {
        if (effect.type === 'quit') return finish(null);
        if (effect.type === 'read') {
          if (!effect.run.seats.length) throw new Error('No seats were saved in this run.');
          const result = await showConversation({ seats: effect.run.seats, cwd: effect.run.cwd, frame: index => {
            const { shelf, surface } = consoleLayout(process.stdout.columns, process.stdout.rows);
            return { region: surface, chrome: paintShelf(shelf, effect.run.seats, index, { mode: 'setup', colorOf:seat=>accentColor(seatAccent(effect.run.seats,effect.run.seats.indexOf(seat))) }) };
          } });
          if (result.quit) return finish(null);
          process.stdout.write('\x1b[?1002h\x1b[?1006h\x1b[?2004h');
        }
        if (effect.type === 'new') {
          await resolveProject(effect.cwd);
          return finish({ cwd: effect.cwd, name: effect.name });
        }
        if (effect.type === 'resume') {
          state.notice = 'Checking saved conversations…'; draw();
          const run = loadHistory().find(item => item.id === effect.run.id);
          if (!run) throw new Error('This run is no longer available.');
          return finish({ cwd: run.cwd, previous: run, restored: await withLoading('Checking saved conversations…', () => prepareResume(run)) });
        }
        if (effect.type === 'pin') {
          const key = projectKey(effect.project.path);
          const nextPins = effect.project.pinned ? pinned.filter(folder => projectKey(folder) !== key) : [...pinned, effect.project.path];
          await savePins(nextPins);
          pinned = nextPins;
          effect.project.pinned = !effect.project.pinned;
          state.notice = effect.project.pinned ? 'Project pinned.' : 'Project unpinned.';
        }
        if (effect.type === 'path') {
          const folder = await resolveProject(effect.value, cwd);
          if (!data.projects.some(item => projectKey(item.path) === projectKey(folder))) data.projects.push({ path: folder, name: path.basename(folder), pinned: false, sessions: data.runs.filter(run => projectKey(run.cwd) === projectKey(folder)).length });
          state = { ...state, page: 'sessions', project: folder, query: '', index: 0, edit: null, notice: null };
        }
      } catch (error) { state.notice = error.message; }
      finally { busy = false; draw(); }
    };
    process.stdout.write((manageScreen ? '\x1b[?1049h' : '') + '\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?2004h');
    process.stdin.on('data', onData);
    process.stdout.on('resize', draw);
    draw();
  });
}
