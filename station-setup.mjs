import { consoleLayout, seatCard, shelfPage, createShelfDrag, surfaceLines } from './station-view.mjs';
import { parseMouse } from './station-links.mjs';
import { cleanLabel } from './station-vocabulary.mjs';
import { seatAccent, accentColor } from './station-identity.mjs';
// Rellin setup (table-mode.md §10, design: station mockups 1/1b): a list of
// seats, one row each — agent, model, effort, mode, status — driven by
// keyboard or mouse. The picker overlays the rows below instead of reflowing
// them. Presets fill the table in one press; "last table" restores the
// previous configuration.
//
// Model and effort options are discovered from the installed providers:
// Claude's --help names its effort levels and model aliases; Codex's own
// catalog (codex debug models, cached in models_cache.json) names its listed
// models and each model's reasoning levels. Discovery is best-effort — a
// failure falls back to a curated floor, never blocks setup.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { codexBinary, commandPath, wrapCommand } from './agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIELDS = ['agent', 'model', 'effort', 'mode'];
const MAX_SEATS = 4, MIN_SEATS = 1;

export const FALLBACK = {
  models: { claude: ['fable', 'opus', 'sonnet', 'haiku'], codex: ['gpt-6-astra'] },
  efforts: { claude: ['medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'] },
};

const merge = (...lists) => [...new Set(lists.flat())];

// Claude's help text is the authority for its own vocabulary: the --effort
// line carries "(low, medium, high, xhigh, max)" and the --model paragraph
// quotes the aliases. Full model names like 'claude-fable-5' stay out — the
// hyphen keeps them from matching.
export function parseClaudeHelp(text) {
  const out = { models: [], efforts: [] };
  const effort = String(text).match(/--effort[^(]*\(([^)]+)\)/);
  if (effort) out.efforts = effort[1].split(',').map(item => item.trim()).filter(item => /^[a-z]+$/.test(item));
  const model = String(text).match(/--model[\s\S]{0,400}/);
  if (model) out.models = [...model[0].matchAll(/'([a-z][a-z0-9]*)'/g)].map(item => item[1]);
  return out;
}

// Codex config: every `model = "..."` (top level and profiles) is a model the
// owner actually uses.
export function parseCodexConfig(text) {
  return {
    models: [...String(text).matchAll(/^\s*model\s*=\s*"([^"]+)"/gm)].map(item => item[1]),
    efforts: [...String(text).matchAll(/model_reasoning_effort\s*=\s*"([^"]+)"/g)].map(item => item[1]),
  };
}

// Codex's official catalog: listed models in priority order, and each
// model's own reasoning levels — effort becomes per-model, so a level one
// model lacks is never offered.
export function parseCodexCatalog(text) {
  const data = JSON.parse(text);
  const listed = (data.models || []).filter(model => model.visibility === 'list' && model.slug)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  const efforts = {};
  const union = new Set();
  for (const model of listed) {
    const levels = (model.supported_reasoning_levels || []).map(level => level.effort).filter(Boolean);
    if (levels.length) efforts[model.slug] = levels;
    for (const level of levels) union.add(level);
  }
  return { models: listed.map(model => model.slug), efforts: { ...efforts, default: [...union] } };
}

// Grok's catalog (~/.grok/models_cache.json): a models object keyed by id,
// each with info.reasoning_efforts — per-model efforts, like codex.
export function parseGrokCatalog(text) {
  const data = JSON.parse(text);
  const infos = Object.values(data.models || {}).map(entry => entry?.info).filter(info => info?.id);
  const efforts = {};
  const union = new Set();
  for (const info of infos) {
    const levels = (info.reasoning_efforts || []).map(level => level.id || level.value).filter(Boolean);
    if (levels.length) efforts[info.id] = levels;
    for (const level of levels) union.add(level);
  }
  return { models: infos.map(info => info.id), efforts: { ...efforts, default: [...union] } };
}

export async function discoverOptions(env = process.env, root = ROOT) {
  const models = { ...FALLBACK.models };
  const efforts = { ...FALLBACK.efforts };
  try {
    const file = commandPath('claude', env);
    if (file) {
      const command = wrapCommand(file, ['--help']);
      const { stdout } = await promisify(execFile)(command.file, command.args, { env, windowsHide: true, timeout: 15000, maxBuffer: 512000 });
      const parsed = parseClaudeHelp(stdout);
      if (parsed.models.length) models.claude = merge(parsed.models, FALLBACK.models.claude);
      if (parsed.efforts.length) efforts.claude = parsed.efforts;
    }
  } catch { /* Help is best-effort; the floor stands. */ }
  let catalog = null;
  try {
    const command = codexBinary(env);
    const { stdout } = await promisify(execFile)(command.file, [...command.args, 'debug', 'models'], { env, windowsHide: true, timeout: 15000, maxBuffer: 4_000_000 });
    catalog = parseCodexCatalog(stdout);
  } catch {
    try { catalog = parseCodexCatalog(await readFile(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8')); } catch { /* No cache either. */ }
  }
  const configModels = [];
  for (const file of [path.join(os.homedir(), '.codex', 'config.toml'), path.join(root, '.codex', 'config.toml')]) {
    try { configModels.push(...parseCodexConfig(await readFile(file, 'utf8')).models); } catch { /* No config there. */ }
  }
  models.codex = merge(catalog?.models || [], configModels, FALLBACK.models.codex);
  if (catalog?.efforts) efforts.codex = { ...catalog.efforts, default: merge(catalog.efforts.default || [], FALLBACK.efforts.codex) };
  try {
    const grok = parseGrokCatalog(await readFile(path.join(os.homedir(), '.grok', 'models_cache.json'), 'utf8'));
    if (grok.models.length) { models.grok = grok.models; efforts.grok = grok.efforts; }
  } catch { /* Grok not installed or no cache yet. */ }
  return { models, efforts };
}

// options: { available, models?, efforts?, last? }. An efforts table is
// either an array (one vocabulary for the vendor) or a per-model object with
// a `default` union, so the dropdown follows the seat's chosen model.
export function fieldOptions(field, seat, options) {
  if (field === 'agent') return options.available;
  if (field === 'mode') return ['manual', 'auto'];
  const tables = (field === 'model' ? options.models : options.efforts) || (field === 'model' ? FALLBACK.models : FALLBACK.efforts);
  const table = tables[seat.agent];
  if (Array.isArray(table)) return ['default', ...table];
  if (table && typeof table === 'object') return ['default', ...(table[seat.model] || table.default || [])];
  return ['default'];
}

const emptySeat = agent => ({ agent, model: 'default', effort: 'default', mode: 'manual' });

export function presetSeats(name, options) {
  const first = options.available[0];
  const pick = wanted => options.available.includes(wanted) ? wanted : first;
  if (name === 'solo') return [emptySeat(first)];
  if (name === 'duo') return [emptySeat(pick('claude')), emptySeat(pick('codex'))];
  if (name === 'quad') return [emptySeat(pick('claude')), emptySeat(pick('codex')), emptySeat(pick('claude')), emptySeat(pick('codex'))];
  // One author, two cross-family critics (conflicts C7: decorrelated review).
  if (name === 'review') return [emptySeat(pick('claude')), emptySeat(pick('codex')), emptySeat(pick('claude'))];
  if (name === 'last' && Array.isArray(options.last) && options.last.length >= MIN_SEATS) {
    return options.last.slice(0, MAX_SEATS).map(seat => ({ ...emptySeat(seat.agent || first), ...seat, mode: 'manual' }));
  }
  return null;
}

export function defaultSetup(available) {
  const seats = [];
  for (const wanted of ['claude', 'codex']) if (available.includes(wanted)) seats.push(emptySeat(wanted));
  while (seats.length < MIN_SEATS && available.length) seats.push(emptySeat(available[0]));
  return { seats, cursor: { seat: 0, field: 0 }, dropdown: null, done: false, cancelled: false };
}

// Render the list and the clickable regions in one pass; the picker overlays
// the rows below (mockup 1b) rather than reflowing them. Rows and columns are
// 1-based to match SGR mouse reports. Lines carry no colour: regions are
// measured in plain characters and must never drift from the pixels.
export function setupRender(state, options) {
  const cols = options.width || 120, rows = options.height || 36;
  const { shelf, surface } = consoleLayout(cols, rows, options.shelfWidth);
  const lines = Array.from({length: rows}, () => '');
  const regions = [];
  let anchor = null;
  const put = (row,column,text) => {
    if(row<1 || row>rows)return;
    const line=(lines[row-1]||'').padEnd(cols);
    lines[row-1]=(line.slice(0,column)+text+line.slice(column+text.length)).slice(0,cols);
  };
  for(let row=1;row<=shelf.height;row++)put(row,shelf.width-1,'│');
  put(1,1,'RELLIN');
  put(2,1,'Drag divider to resize');
  put(2,shelf.width-1,'↔');
  put(1,surface.x+1,'New session');
  put(3,surface.x+1,'Who works in this Rellin session?');
  put(5,surface.x+1,cleanLabel(options.cwd || ''));
  const focused = state.seats[state.cursor.seat];
  put(7,surface.x+1,'Seat ' + (state.cursor.seat+1) + ' · ' + focused.agent);
  put(9,surface.x+1,'Model: ' + focused.model);
  put(10,surface.x+1,'Effort: ' + focused.effort);
  put(11,surface.x+1,'Mode: ' + (focused.mode==='auto' ? 'BYPASS' : 'manual'));
  put(13,surface.x+1,'Nothing launches until Enter.');
  put(14,surface.x+1,'Click a field to choose. Presets change the lineup.');
  put(16,surface.x+1,'[ Start session ]');
  if (rows > 16) regions.push({row:16,x1:surface.x+2,x2:Math.min(cols,surface.x+18),action:{type:'start'}});
  const buttons = [...(options.last?['last table']:[]),'solo','duo','quad','review'].map(name=>({name,label:`[ ${name} ]`}));
  const rowWidth = buttons.reduce((sum,button)=>sum+button.label.length,buttons.length-1);
  const presetRows = rowWidth <= shelf.width-2 ? [buttons] : buttons.map(button=>[button]);
  const presetTop = shelf.height-presetRows.length;
  const continueRow = presetTop-2;
  const {start,capacity} = shelfPage({...shelf,height:continueRow-2},state.seats.length,state.cursor.seat);
  if (state.seats.length < MAX_SEATS && state.seats.length >= capacity && rows > 18) {
    put(18,surface.x+1,'[ + Add agent ]');
    regions.push({row:18,x1:surface.x+2,x2:Math.min(cols,surface.x+16),action:{type:'add'}});
  }
  state.seats.slice(start,start+capacity).forEach((seat,offset) => {
    const index=start+offset, top=3+offset*6;
    const card=seatCard(seat,index,{width:shelf.width-2,mode:'setup'}).map(cleanLabel);
    card.forEach((line,row)=>put(top+row,0,(index===state.cursor.seat && row===state.cursor.field ? '›':' ')+line));
    FIELDS.forEach((field,fieldIndex)=>{
      const row=top+fieldIndex;
      regions.push({row,x1:2,x2:Math.min(shelf.width-1,card[fieldIndex].length+1),action:{type:'open',seat:index,field:fieldIndex}});
      if(state.dropdown?.seat===index && state.dropdown.field===field)anchor={row,column:1};
    });
  });
  if(state.seats.length<MAX_SEATS && state.seats.length<capacity) {
    const row=3+state.seats.length*6;
    const card=seatCard({empty:true},state.seats.length,{width:shelf.width-2,mode:'setup'}).map(cleanLabel);
    put(row,1,card[0]); put(row+1,1,'[ + Add agent ]');
    regions.push({row,x1:2,x2:Math.min(shelf.width-1,card[0].length+1),action:{type:'add'}});
    regions.push({row:row+1,x1:2,x2:16,action:{type:'add'}});
  }
  if (state.seats.length > capacity) {
    const row = continueRow-1;
    put(row,1,`[ ↑ ] [ ↓ ] ${state.cursor.seat+1}/${state.seats.length}`);
    regions.push({row,x1:2,x2:6,action:{type:'move',seats:-1}}, {row,x1:8,x2:12,action:{type:'move',seats:1}});
  }
  put(continueRow,1,'[ Continue session ]');
  regions.push({row:continueRow,x1:2,x2:21,action:{type:'continue'}});
  put(presetTop,1,'Choose a preset');
  presetRows.forEach((buttons,offset) => {
    let column=1;
    for(const {name,label} of buttons) {
      const row=presetTop+1+offset;
      put(row,column,label);
      regions.push({row,x1:column+1,x2:column+label.length,action:{type:'preset',name:name==='last table'?'last':name}});
      column+=label.length+1;
    }
  });
  put(rows,0,' ↑↓ seat · Tab field · ←→ change · a add · c continue · Enter start · q quit');
  if (state.dropdown && anchor) {
    const seat = state.seats[state.dropdown.seat];
    const allChoices = fieldOptions(state.dropdown.field === 'number' ? 'agent' : state.dropdown.field, seat, options);
    const limit = Math.max(1, rows-4), selected = Math.max(0,allChoices.indexOf(String(seat[state.dropdown.field])));
    const first = Math.max(0, Math.min(selected-Math.floor(limit/2),allChoices.length-limit));
    const choices = allChoices.slice(first, first+limit);
    anchor.row = Math.max(1,Math.min(anchor.row,rows-choices.length-3));
    const width = Math.min(cols-2,Math.max(shelf.width-2,...choices.map(choice => choice.length + 6)));
    const put = (row, column, text) => {
      while (lines.length < row) lines.push('');
      const line = (lines[row - 1] || '').padEnd(column + text.length);
      lines[row - 1] = line.slice(0, column) + text + line.slice(column + text.length);
    };
    put(anchor.row + 1, anchor.column, `┌${'─'.repeat(width - 2)}┐`);
    choices.forEach((choice, index) => {
      const current = String(seat[state.dropdown.field]) === choice;
      put(anchor.row + 2 + index, anchor.column, `│${current ? ' ▸ ' : '   '}${choice.slice(0,width-5).padEnd(width - 5)}│`);
      regions.push({ row: anchor.row + 2 + index, x1: anchor.column + 1, x2: anchor.column + width, action: { type: 'pick', seat: state.dropdown.seat, field: state.dropdown.field, value: choice } });
    });
    put(anchor.row + 2 + choices.length, anchor.column, `└${'─'.repeat(width - 2)}┘`);
  }
  return { lines, regions };
}

// The overlay's regions are pushed after the rows they cover, so the last
// match wins — a click lands on what is visibly on top.
export function actionAt(regions, x, y) {
  return regions.findLast(region => region.row === y && x >= region.x1 && x <= region.x2)?.action || { type: 'close' };
}

export function setupApply(state, action, options) {
  switch (action.type) {
    case 'open': {
      const field = FIELDS[action.field] ?? action.field;
      const same = state.dropdown && state.dropdown.seat === action.seat && state.dropdown.field === field;
      return { ...state, cursor: { seat: action.seat, field: FIELDS.indexOf(field) }, dropdown: same ? null : { seat: action.seat, field } };
    }
    case 'pick': {
      const seats = state.seats.map((seat, index) => {
        if (index !== action.seat) return seat;
        if (action.field === 'agent') return emptySeat(action.value);
        return { ...seat, [action.field]: action.value };
      });
      return { ...state, seats, dropdown: null };
    }
    case 'move': {
      const seat = Math.min(Math.max(state.cursor.seat + (action.seats || 0), 0), state.seats.length - 1);
      const field = (state.cursor.field + (action.fields || 0) + FIELDS.length) % FIELDS.length;
      return { ...state, cursor: { seat, field }, dropdown: null };
    }
    case 'cycle': {
      const seat = state.seats[state.cursor.seat];
      const field = FIELDS[state.cursor.field];
      const choices = fieldOptions(field, seat, options);
      const index = (choices.indexOf(String(seat[field])) + action.delta + choices.length) % choices.length;
      return setupApply(state, { type: 'pick', seat: state.cursor.seat, field, value: choices[index] }, options);
    }
    case 'preset': {
      const seats = presetSeats(action.name, options);
      return seats ? { ...state, seats, cursor: { seat: 0, field: 0 }, dropdown: null } : state;
    }
    case 'add':
      if (state.seats.length >= MAX_SEATS) return state;
      return { ...state, seats: [...state.seats, emptySeat(options.available[0])], cursor: { seat: state.seats.length, field: 0 }, dropdown: null };
    case 'remove':
      if (state.seats.length <= MIN_SEATS) return state;
      return { ...state, seats: state.seats.filter((seat, index) => index !== action.seat), cursor: { seat: 0, field: 0 }, dropdown: null };
    case 'start':
      return { ...state, done: true };
    case 'quit':
      return { ...state, cancelled: true };
    case 'close':
      return { ...state, dropdown: null };
    default:
      return state;
  }
}

// Colour is applied at draw time only (design PNG 01): regions are measured
// on the plain lines, so the colourizer may insert SGR codes but must never
// add or remove a visible character.
const SEAT_ROW = /^([› ])(\d)( )(\S+)/;
export function colorizeSetup(line, index, state, seatColor) {
  // Underline bounded controls without changing their measured hit regions.
  line = line.replace(/\[[^\]]+\]/g, text => `\x1b[4m${text}\x1b[24m`);
  if (/\bBYPASS\b/.test(line)) return line.replace(/\bBYPASS\b/g, '\x1b[7mBYPASS\x1b[27m');
  const dim = text => `\x1b[2m${text}\x1b[0m`;
  if (index === 1) return line.replace('RELLIN', '\x1b[1mSTATION\x1b[0m').replace(/(\S*[\\/]\S+)$/, match => dim(match));
  if (/^    # agent/.test(line) || /^\s*─+\s*$/.test(line) || /^  ↑↓ /.test(line)) return dim(line);
  const seat = /○ empty/.test(line) ? null : SEAT_ROW.exec(line);
  if (seat) {
    const accent = seatColor(Number(seat[2]) - 1) || '';
    let out = line.replace(SEAT_ROW, (match, lead, number, gap, agent) => `${lead}${accent}${Number(number)-1 === state.cursor.seat ? '\x1b[1m' : ''}${number}${gap}${agent}\x1b[0m`);
    out = out.replace(/[‹›]/g, match => dim(match)).replace('● ready', '\x1b[32m●\x1b[0m ready').replace('✕ gone', '\x1b[31m✕\x1b[0m gone');
    if (line.startsWith('  ▸')) out = `\x1b[48;5;236m${out.replace(/\x1b\[0m/g, '\x1b[0m\x1b[48;5;236m')}\x1b[0m`;
    return out.replace(/\bBYPASS\b/g, '\x1b[7mBYPASS\x1b[27m');
  }
  if (/○ empty/.test(line)) return dim(line).replace('a  seat someone', '\x1b[0ma\x1b[2m  seat someone');
  if (/^    presets/.test(line)) return line.replace('presets', dim('presets'));
  if (/[│┌┐└┘]/.test(line)) return line.replace(/[│┌┐└┘─]/g, match => dim(match)).replace('▸', '\x1b[1m▸\x1b[0m');
  return line;
}

// SGR mouse: left-button presses only; motion and release are ignored.
export function parseSgrClicks(chunk) {
  const clicks = [];
  for (const match of String(chunk).matchAll(/\x1b\[<(\d+);(\d+);(\d+)M/g)) {
    const button = Number(match[1]);
    if ((button & 3) === 0 && !(button & 32) && !(button & 64)) clicks.push({ x: Number(match[2]), y: Number(match[3]) });
  }
  return clicks;
}

export function runSetup(options) {
  return new Promise(resolve => {
    let state = defaultSetup(options.available);
    if(options.last?.length && options.last.every(seat=>options.available.includes(seat.agent))) state.seats=presetSeats('last',options);
    if(options.draft?.length) state.seats=options.draft;
    let regions = [];
    const resizeShelf = createShelfDrag();
    const draw = () => {
      const rendered = setupRender(state, {...options,width:process.stdout.columns,height:process.stdout.rows});
      regions = rendered.regions;
      const seatColor = index => accentColor(seatAccent(state.seats,index));
      process.stdout.write('\x1b[?25l' + surfaceLines(rendered.lines.map((line, index) => colorizeSetup(line, index, state, seatColor)),{x:0,y:0,width:process.stdout.columns,height:process.stdout.rows}));
    };
    const finish = value => {
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', draw);
      if (options.manageScreen !== false) process.stdout.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l\x1b[?25h');
      resolve(value);
    };
    const step = action => {
      if(action.type==='continue') return finish({browse:true,seats:state.seats});
      state = setupApply(state, action, options);
      if (state.done) return finish(state.seats);
      if (state.cancelled) return finish(null);
      draw();
    };
    const KEYS = {
      c: { type: 'continue' },
      '\x1b': { type: 'close' },
      '\r': { type: 'start' }, q: { type: 'quit' }, '\x03': { type: 'quit' }, '\x11': { type: 'quit' },
      a: { type: 'add' }, '\t': { type: 'move', fields: 1 },
      '\x1b[A': { type: 'move', seats: -1 }, '\x1b[B': { type: 'move', seats: 1 },
      '\x1b[C': { type: 'cycle', delta: 1 }, '\x1b[D': { type: 'cycle', delta: -1 },
    };
    const onData = chunk => {
      if (String(chunk).includes('\x1b[<')) {
        for (const event of parseMouse(chunk)) {
          if (resizeShelf(event,process.stdout.columns,process.stdout.rows)) { state.dropdown=null; draw(); }
          else if(event.kind==='press') step(actionAt(regions,event.x,event.y));
        }
        return;
      }
      if (chunk === 'x') return step({ type: 'remove', seat: state.cursor.seat });
      if (KEYS[chunk]) return step(KEYS[chunk]);
      for (const click of parseSgrClicks(chunk)) step(actionAt(regions, click.x, click.y));
    };
    process.stdout.write((options.manageScreen !== false ? '\x1b[?1049h' : '') + '\x1b[?1002h\x1b[?1006h');
    process.stdin.on('data', onData);
    process.stdout.on('resize', draw);
    draw();
  });
}
