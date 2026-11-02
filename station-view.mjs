// Rellin's Console: one persistent shelf and one work surface. Native
// output comes only from headless buffers; child terminal modes cannot leak.

import { cleanLabel, attentionPresentation, seatLabel, posture, clipLabel, plainWidth, STATE_COLORS } from './station-vocabulary.mjs';
import { activityBuckets, activitySparkline } from './station-activity.mjs';
import { cacheLine, cacheDetails } from './station-cache.mjs';
export { elapsedLabel, GLYPHS, STATE_COLORS } from './station-vocabulary.mjs';
export const RAIL_WIDTH = 26;
let preferredShelfWidth = RAIL_WIDTH;
let saveWidth = () => {};
export function configureShelf({shelfWidth = RAIL_WIDTH, onChange = () => {}} = {}) {
  preferredShelfWidth = Number.isInteger(shelfWidth) && shelfWidth>=RAIL_WIDTH ? shelfWidth : RAIL_WIDTH;
  saveWidth = onChange;
}

// The Console keeps the same work width for every seat count and surface.
export function consoleLayout(cols, rows, requestedWidth = preferredShelfWidth) {
  const width = Math.max(1, cols), height = Math.max(1, rows - 1);
  const maximum = Math.max(0, width - Math.min(40, Math.max(16, width - RAIL_WIDTH)));
  const shelfWidth = Math.min(maximum, Math.max(RAIL_WIDTH, Math.round(requestedWidth) || RAIL_WIDTH));
  return { shelf: { x: 0, y: 0, width: shelfWidth, height },
    surface: { x: shelfWidth, y: 0, width: width - shelfWidth, height } };
}
// One width for the whole run, including startup and setup. Window shrinkage
// clamps the rendered size without forgetting the user's preferred width.
export function createShelfDrag() {
  let dragging = false;
  return (event, cols, rows) => {
    const { shelf } = consoleLayout(cols, rows);
    if (event.kind === 'press') {
      dragging = event.x === shelf.width && event.y <= shelf.height && !event.ctrl;
      return dragging;
    }
    if (!dragging || !['drag', 'release'].includes(event.kind)) return false;
    preferredShelfWidth = consoleLayout(cols, rows, event.x).shelf.width;
    if (event.kind === 'release') { dragging = false; saveWidth(preferredShelfWidth); }
    return true;
  };
}
const fitLabel = (text, width) => plainWidth(text) > width
  ? clipLabel(text, Math.max(0, width - 1)) + (width > 0 ? '…' : '') : text;
export const inner = region => region;
const move = (row, column) => `\x1b[${row + 1};${column + 1}H`;
export const surfaceLines = (lines, region) => Array.from({ length: region.height }, (_, row) => {
  const text = clipLabel(lines[row] || '', region.width);
  return move(region.y + row, region.x) + '\x1b[0m' + text + ' '.repeat(Math.max(0, region.width - plainWidth(text)));
}).join('');
// Offset a surface's absolute cursor moves; never clear an entire terminal row.
export const offsetSurface = (out, region) => out.replace(/\x1b\[(\d+);(\d+)H/g,
  (_, row, col) => `\x1b[${Number(row) + region.y};${Number(col) + region.x}H`);

// A formatter of the shared presentation, not a second state classifier.
export function seatCard(seat, index, { width = 24, now = Date.now(), series = [], readToken = null, mode = 'live', focused = true, reading = false } = {}) {
  if (mode === 'setup') {
    if (seat.empty) return [`${index + 1} ○ empty`, 'a seats someone', '', '', ''].map(line => clipLabel(line, width));
    return [`${index + 1} ${cleanLabel(seat.agent || seat.seat)} ▾`, `model [${cleanLabel(seat.model || 'default')} ▾]`, `effort [${cleanLabel(seat.effort || 'default')} ▾]`, `mode [${posture(seat) || 'manual'} ▾]`, '○ not launched'].map(line => fitLabel(line, width));
  }
  const item = attentionPresentation(seat, now), badge = posture(seat);
  const identity = [seat.seat || seat.agent, seat.model, seat.effort].filter(value => value && value !== 'default').join(' · ');
  const prefix = `${index + 1} `;
  const name = fitLabel(cleanLabel(identity), Math.max(0, width - prefix.length - (badge ? 7 : 0)));
  // Keep the full state/evidence before spending space on its sparkline.
  const state = ['blocked', 'error', 'unverified'].includes(item.kind)
    ? `${item.glyph} ${item.kind}${item.evidence ? ' ' + item.evidence : ''}`
    : `${item.glyph} ${item.kind === 'working' ? item.label.split(' · ')[0] : item.kind === 'done' ? `done ${item.unread} unread` : item.label}`;
  const spark = activitySparkline(activityBuckets(series, now));
  const room = width - plainWidth(state) - 1;
  const stateLine = state + (room >= 8 ? ' ' + spark : '');
  const detail = item.kind === 'unverified' ? item.reason
    : item.kind === 'blocked' ? `${seat.attention?.waitReason === 'prompt' ? seat.attention.promptKind || 'choice' : item.reason}${seat.attention?.watcher?.state !== 'healthy' ? ' · ◌ unverified' : ''}`
    : item.kind === 'error' ? item.reason
    : item.kind === 'working' ? `${item.evidence ? 'Turn in progress' : 'Native turn in progress'}${item.unread ? ` · ${item.unread} unread` : ''}`
    : item.kind === 'done' ? `Latest answer v${item.readVersion}`
    : item.kind === 'exited' ? 'Process stopped'
    : item.kind === 'empty' ? 'No completed answer yet' : 'Waiting for your input';
  const action = readToken && readToken.nativeId === seat.nativeId ? `m read v${readToken.version}`
    : reading ? focused ? 'Esc back' : 'Tab switches seats'
    : !focused ? `Alt+${index + 1} focus`
    : item.kind === 'unverified' || item.kind === 'exited' ? 'Alt+S inspect / restart'
    : item.kind === 'blocked' ? 'Answer in terminal'
    : item.unread ? `Alt+T read v${item.readVersion}` : `Alt+${index + 1} terminal`;
  return [prefix + name + (badge ? ' ' + badge : ''), stateLine, cleanLabel(detail), action, cacheLine(seat, now, width)].map(line => fitLabel(line, width));
}

// Five rows per seat, one blank separator. Short terminals page the shelf
// around focus; focusing a hidden seat never changes the work geometry.
export function shelfPage(region, count, focus) {
  const capacity = Math.max(1, Math.floor((region.height - 3) / 6));
  const start = Math.min(Math.max(0, count - capacity), Math.floor(focus / capacity) * capacity);
  return { start, capacity };
}
export function shelfSeatAt(region, count, focus, x, y) {
  if (x < region.x || x >= region.x + region.width - 1 || y < 2 || y >= region.height - 1) return -1;
  const index = shelfPage(region, count, focus).start + Math.floor((y - 2) / 6);
  return index < count ? index : -1;
}
export function shelfActionAt(region, seats, focus, x, y) {
  const index=shelfSeatAt(region,seats.length,focus,x,y);
  if(index<0)return null;
  if((y-2)%6===4 && ['claude','codex'].includes(seats[index]?.agent)) return {index,key:'\x1bu'};
  if(index!==focus || (y-2)%6!==3)return {index,key:null};
  const item=attentionPresentation(seats[index]);
  const key=['unverified','exited'].includes(item.kind)?'\x1bs':item.kind!=='blocked' && item.unread?'\x1bt':null;
  return {index,key};
}
export function paintShelf(region, seats, focus, { colorOf = () => '', now = Date.now(), series = new Map(), reader = null, mode = 'live' } = {}) {
  if (!region.width) return '';
  const width = Math.max(1, region.width - 1), lines = [' RELLIN', ' Drag divider to resize'];
  const { start, capacity } = shelfPage(region, seats.length, focus);
  seats.slice(start, start + capacity).forEach((seat, offset) => {
    const index = start + offset, item = attentionPresentation(seat, now);
    const card = seatCard(seat, index, { width: width - 1, now, series: series.get(seat.seat) || [], readToken: reader?.seat === index ? reader.token : null, mode, focused: index === focus, reading: !!reader });
    for (const [row, line] of card.entries()) {
      const style = row === 0 ? colorOf(seat) + (index === focus ? '\x1b[1m' : '') : row === 1 && mode === 'live' ? STATE_COLORS[item.kind] : '';
      lines.push(`${row === 0 && index === focus ? '›' : ' '}${style}${line}\x1b[0m`);
    }
    lines.push('');
  });
  if (seats.length > capacity) lines[region.height - 1] = ` ${start + 1}–${Math.min(seats.length, start + capacity)} / ${seats.length} · Alt+1..4`;
  return surfaceLines(Array.from({ length: region.height }, (_, row) => {
    const text = clipLabel(lines[row] || '', region.width - 1);
    return text + ' '.repeat(Math.max(0, region.width - 1 - plainWidth(text))) + (row === 1 ? '↔' : '\x1b[2m│\x1b[0m');
  }), region);
}

// The address overlay (mockup 5): a boxed composer above the status bar —
// "to" chips, the prompt lines, the keys in the bottom border.
export function paintComposer({ width, usableRows, seats, targets, text, colorOf, wrap }) {
  const lines = wrap(text, width - 4).slice(-8);
  const height = lines.length + 3;
  const top = usableRows - height;
  const chips = seats.map((seat, index) => {
    const member = targets === 'all' || targets.includes(index);
    const label = `${index + 1} ${seatLabel(seat)}`;
    return member ? `${colorOf(seat)}\x1b[7m[${label}]\x1b[0m` : `\x1b[2m[${label}]\x1b[0m`;
  }).join(' ');
  const all = targets === 'all' ? '\x1b[1m@all\x1b[0m' : '\x1b[2m@all\x1b[0m';
  let out = move(top, 0) + `\x1b[0m┏ address ${'━'.repeat(Math.max(0, width - 12))}┓`;
  out += move(top + 1, 0) + `┃\x1b[0K` + move(top + 1, 1) + ` to   ${chips}   ${all}` + move(top + 1, width - 1) + '┃';
  lines.forEach((line, index) => {
    out += move(top + 2 + index, 0) + `┃\x1b[0K` + move(top + 2 + index, 2) + `${index === 0 ? '› ' : '  '}${line}` + move(top + 2 + index, width - 1) + '┃';
  });
  const hint = ' Enter send · Alt+⇧N toggle a seat · Alt+` all · Alt+Enter newline · Esc back ';
  out += move(top + height - 1, 0) + `┗${hint}${'━'.repeat(Math.max(0, width - hint.length - 2))}┛`;
  // The cursor sits at the end of the LAST text row (top border, chips row,
  // then lines.length text rows), after the two-character '› '/'  ' prefix.
  return { out, cursor: { row: top + 1 + lines.length, column: 4 + (lines[lines.length - 1] || '').length } };
}

// One cell's SGR, always from reset so no state carries between cells with
// different styles.
export function cellStyle(cell) {
  const params = ['0'];
  if (cell.isBold()) params.push('1');
  if (cell.isDim()) params.push('2');
  if (cell.isItalic()) params.push('3');
  if (cell.isUnderline()) params.push('4');
  if (cell.isInverse()) params.push('7');
  if (cell.isFgRGB()) { const c = cell.getFgColor(); params.push('38', '2', String(c >> 16 & 255), String(c >> 8 & 255), String(c & 255)); }
  else if (!cell.isFgDefault()) params.push('38', '5', String(cell.getFgColor()));
  if (cell.isBgRGB()) { const c = cell.getBgColor(); params.push('48', '2', String(c >> 16 & 255), String(c >> 8 & 255), String(c & 255)); }
  else if (!cell.isBgDefault()) params.push('48', '5', String(cell.getBgColor()));
  return `\x1b[${params.join(';')}m`;
}

// One buffer row rendered to exactly `width` columns. Wide glyphs occupy two
// cells; one that would straddle the right edge becomes a space. `selected`
// is an inclusive column range painted inverse (the station owns selection:
// terminal-native selection cannot see pane boundaries).
export function renderLine(line, width, selected) {
  let out = '', style = null, used = 0;
  for (let x = 0; used < width && line && x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const glyphWidth = cell.getWidth();
    if (used + glyphWidth > width) break;
    const inSelection = selected && used >= selected.from && used <= selected.to;
    const next = cellStyle(cell) + (cell.extended?.urlId ? '\x1b[4m' : '') + (inSelection ? '\x1b[7m' : '');
    if (next !== style) { out += next; style = next; }
    out += cell.getChars() || ' ';
    used += glyphWidth;
  }
  let pad = ' '.repeat(width - used);
  if (selected && selected.to >= used) {
    const from = Math.max(selected.from, used) - used;
    const to = Math.min(selected.to, width - 1) - used;
    if (to >= from) pad = pad.slice(0, from) + '\x1b[0;7m' + pad.slice(from, to + 1) + '\x1b[0m' + pad.slice(to + 1);
  }
  return out + '\x1b[0m' + pad;
}

// Selections are held in buffer-absolute rows so they stay glued to their
// text when the seat scrolls.
export const orderSelection = sel =>
  (sel.anchorRow < sel.headRow || (sel.anchorRow === sel.headRow && sel.anchorCol <= sel.headCol))
    ? { startRow: sel.anchorRow, startCol: sel.anchorCol, endRow: sel.headRow, endCol: sel.headCol }
    : { startRow: sel.headRow, startCol: sel.headCol, endRow: sel.anchorRow, endCol: sel.anchorCol };

export function selectionRange(sel, row, width) {
  if (!sel) return null;
  const s = orderSelection(sel);
  if (row < s.startRow || row > s.endRow) return null;
  return { from: row === s.startRow ? s.startCol : 0, to: row === s.endRow ? s.endCol : width - 1 };
}

// Extract the selected text in reading order; rows that are soft-wrapped
// continuations join without a newline, so a copied paragraph is whole.
export function selectionText(terminal, sel) {
  const s = orderSelection(sel);
  const buffer = terminal.buffer.active;
  let out = '';
  for (let row = s.startRow; row <= s.endRow; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    out += line.translateToString(true, row === s.startRow ? s.startCol : 0, row === s.endRow ? s.endCol + 1 : undefined);
    if (row < s.endRow && !buffer.getLine(row + 1)?.isWrapped) out += '\n';
  }
  return out;
}

// A pane's content: the seat's viewport painted into the inner region.
export function paintContent(terminal, pane, selection) {
  const region = inner(pane);
  const buffer = terminal.buffer.active;
  let out = '';
  for (let row = 0; row < region.height; row++) {
    const bufferRow = buffer.viewportY + row;
    out += move(region.y + row, region.x) + renderLine(buffer.getLine(bufferRow), region.width, selectionRange(selection, bufferRow, region.width));
  }
  return out;
}

export const tokenLabel = count => count == null ? '?' : count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);

// Alt+U: per-seat usage with a station-wide total, read on demand from the
// seats' native transcripts. `usage` is null while loading, per-seat null
// when a seat has no watcher.
export function usageLines({ seats, usage, width, colorOf, focus = 0, cacheReminders = false, now = Date.now() }) {
  const focused = seats[focus];
  const lines = [' Usage · native history',
    ` Cache reminders ${cacheReminders ? 'on' : 'off'}`,
    ' r toggle · s snooze focused seat 10m',
    ' Focused seat · ' + cleanLabel(focused?.seat || focused?.agent || '')];
  if(focused) lines.push(...cacheDetails(focused,now).map(line=>' '+line));
  if(focused?.cache?.snoozeUntil > now) lines.push(' Reminders snoozed for this seat.');
  lines.push('');
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let known = 0;
  seats.forEach((seat,index) => {
    const u = usage?.[index];
    lines.push(' ' + colorOf(seat) + (index + 1) + ' ' + seatLabel(seat) + '\x1b[0m');
    if (!u) { lines.push(usage ? '   Usage unavailable' : '   Reading native usage…'); lines.push(''); return; }
    known++;
    for(const key of Object.keys(total)) total[key] = total[key] === null || u[key] == null ? null : total[key] + u[key];
    lines.push('   input ' + tokenLabel(u.input) + ' · output ' + tokenLabel(u.output));
    lines.push('   cache read ' + tokenLabel(u.cacheRead) + ' · write ' + tokenLabel(u.cacheWrite));
    lines.push('');
  });
  if(known) {
    lines.push(' Reported total · ' + known + '/' + seats.length + ' seats');
    lines.push(' input ' + tokenLabel(total.input) + ' · output ' + tokenLabel(total.output));
    lines.push(' cache read ' + tokenLabel(total.cacheRead) + ' · write ' + tokenLabel(total.cacheWrite));
  } else lines.push(usage ? ' No usage totals available.' : ' Reading…');
  // Reserve the last line for a close action, even in a short terminal.
  const wrapped = lines.flatMap(line => {
    const result=[], indent=/^ */.exec(line)[0];let current=indent;
    for(const word of line.trimStart().split(' ')) {
      if(current.trim() && plainWidth(current+' '+word)>width) {result.push(current);current=indent+word;}
      else current += (current.trim()?' ':'')+word;
    }
    result.push(current);return result;
  });
  return wrapped;
}
export function renderUsageModal(options) {
  const {width,height,scroll=0}=options, wrapped=usageLines(options);
  const start = Math.min(Math.max(0,scroll),Math.max(0,wrapped.length-height+1));
  const visible = wrapped.slice(start,start+Math.max(0,height-1));
  while(visible.length < height-1) visible.push('');
  visible.push(' ↑↓ scroll · Esc or Alt+U back');
  return surfaceLines(visible, {x:0,y:0,width,height}) + '\x1b[?25l';
}

// Where the real cursor belongs: the focused seat's cursor cell, inside its
// inner region, when visible.
export function cursorPosition(terminal, pane) {
  const region = inner(pane);
  const buffer = terminal.buffer.active;
  if (buffer.cursorY < 0 || buffer.cursorY >= region.height || buffer.cursorX >= region.width) return null;
  return { row: region.y + buffer.cursorY + 1, column: region.x + buffer.cursorX + 1 };
}
