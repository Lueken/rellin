import { stripVTControlCharacters } from 'node:util';

// Transcript Markdown has no native terminal theme metadata. These palettes
// follow the owner's Claude (blue) / Codex (rose, green, gold) examples.
const RESET = '\x1b[0m';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = text => [...segmenter.segment(String(text))].map(part => part.segment);
const palettes = {
  claude: { accent: '\x1b[38;2;100;155;255m', code: '\x1b[38;2;100;155;255m', heading: '\x1b[1m' },
  codex: { accent: '\x1b[38;2;255;133;173m', code: '\x1b[38;2;158;218;145m', heading: '\x1b[1;38;2;255;133;173m' },
};
const clean = text => stripVTControlCharacters(String(text)).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '    ');
export const cellWidth = char => {
  if (/\p{Mark}|\u200d|\ufe0f/u.test(char)) return 0;
  const n = char.codePointAt(0);
  return n >= 0x1100 && (n <= 0x115f || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7a3 || n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0x1f300) ? 2 : 1;
};
export const graphemeWidth = text => text.includes('\ufe0f') ? 2 : Math.max(0, ...[...text].map(cellWidth));
export const displayWidth = text => graphemes(stripVTControlCharacters(String(text))).reduce((n, c) => n + graphemeWidth(c), 0);
const size = displayWidth;
const cells = (text, style = '') => graphemes(text).map(char => ({ char, style, width: graphemeWidth(char) }));
export function clipCells(text, width) {
  let out = '', used = 0;
  for (const token of String(text).split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[/.test(token)) { out += token; continue; }
    for (const cluster of graphemes(token)) {
      const length = graphemeWidth(cluster);
      if (used + length > Math.max(0, width)) return out + RESET;
      out += cluster; used += length;
    }
  }
  return out + RESET;
}
function inline(text, palette, style = '') {
  const out = [], pattern = /(`+)([^`]+)\1|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\(([^)]+)\)|\*([^*]+)\*/g;
  let end = 0;
  for (const m of text.matchAll(pattern)) {
    out.push(...cells(text.slice(end, m.index), style));
    if (m[1]) out.push(...cells(m[2], palette.code));
    else if (m[3] || m[4]) out.push(...inline(m[3] || m[4], palette, '\x1b[1m' + palette.accent));
    else if (m[5]) out.push(...cells(m[5] === m[6] ? m[5] : `${m[5]} (${m[6]})`, palette.code));
    else out.push(...cells(m[7], '\x1b[3m' + style));
    end = m.index + m[0].length;
  }
  out.push(...cells(text.slice(end), style));
  return out;
}
function paint(chars) {
  let style = '', out = '';
  for (const cell of chars) {
    if (cell.style !== style) { out += RESET + cell.style; style = cell.style; }
    out += cell.char;
  }
  return out + RESET;
}
function wrap(chars, width, words = true) {
  width = Math.max(1, width);
  const lines = [];
  let start = 0;
  while (start < chars.length) {
    let end = start, used = 0, space = -1;
    while (end < chars.length && used + chars[end].width <= width) {
      if (chars[end].char === ' ') space = end;
      used += chars[end++].width;
    }
    if (end === start) { lines.push('�' + RESET); start++; continue; }
    if (words && end < chars.length && space > start) end = space;
    lines.push(paint(chars.slice(start, end)));
    start = end;
    if (words) while (chars[start]?.char === ' ') start++;
  }
  return lines.length ? lines : [''];
}
const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
const isDivider = line => line.includes('|') && splitRow(line).every(cell => /^:?-{3,}:?$/.test(cell));

function tableRows(rows, width, palette) {
  const count = rows[0].length;
  if (count > 8 || width < count * 8 + (count - 1) * 3) {
    // At narrow widths, preserve every cell as a labeled block rather than
    // clipping columns or forcing the terminal to wrap into the shelf.
    return rows.slice(1).flatMap(row => [...row.flatMap((cell, i) => wrap(inline(`${rows[0][i]}: ${cell}`, palette), width)), '']);
  }
  const rich = rows.map(row => Array.from({ length: count }, (_, i) => inline(row[i] || '', palette)));
  const desired = Array.from({ length: count }, (_, i) => Math.max(8, ...rich.map(row => row[i].reduce((sum, c) => sum + c.width, 0))));
  const widths = Array(count).fill(8);
  let spare = width - (count - 1) * 3 - widths.reduce((sum, n) => sum + n, 0);
  while (spare-- > 0) {
    const index = desired.map((n, i) => n - widths[i]).reduce((best, n, i, a) => n > a[best] ? i : best, 0);
    if (widths[index] >= desired[index]) break;
    widths[index]++;
  }
  const rule = '\x1b[90m' + widths.map(n => '─'.repeat(n)).join('─┼─') + RESET;
  const output = [];
  for (const [index, row] of rich.entries()) {
    const columns = row.map((chars, i) => wrap(index === 0 ? chars.map(c => ({ ...c, style: '\x1b[1m' + (palette === palettes.codex ? '\x1b[38;2;245;214;150m' : palette.accent) })) : chars, widths[i]));
    for (let line = 0; line < Math.max(...columns.map(c => c.length)); line++) {
      output.push(columns.map((column, i) => (column[line] || '') + ' '.repeat(Math.max(0, widths[i] - size(column[line] || '')))).join(' │ '));
    }
    if (index < rich.length - 1) output.push(rule);
  }
  return output;
}

export function renderMarkdown(text, width, agent = 'claude') {
  const palette = palettes[agent] || palettes.claude;
  const source = clean(text).normalize('NFC').split('\n'), out = [];
  let fence = null;
  for (let i = 0; i < source.length; i++) {
    const line = source[i];
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) { fence = marker[1][0]; out.push(...wrap(cells(marker[2].trim() || 'code', '\x1b[2m'), width)); }
      else if (marker[1][0] === fence) fence = null;
      else out.push(...wrap(cells(line, palette.code), width, false));
      continue;
    }
    if (fence) { out.push(...wrap(cells(line, palette.code), width, false)); continue; }
    if (i + 1 < source.length && line.includes('|') && isDivider(source[i + 1])) {
      const rows = [splitRow(line)]; i += 2;
      while (i < source.length && source[i].trim() && source[i].includes('|')) rows.push(splitRow(source[i++]));
      i--; out.push(...tableRows(rows, width, palette)); continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/);
    if (heading) { out.push(...wrap(inline(heading[1], palette, palette.heading), width)); continue; }
    const list = line.match(/^(\s*)([-*+] |\d+\. )(.+)$/);
    const quote = line.match(/^>\s?(.*)$/);
    const prefix = list ? list[1] + (/[0-9]/.test(list[2]) ? list[2] : '• ') : quote ? '│ ' : '';
    const lines = wrap(inline(list ? list[3] : quote ? quote[1] : line, palette), Math.max(1, width - size(prefix)));
    out.push(...lines.map((part, n) => (n ? ' '.repeat(size(prefix)) : prefix) + part));
  }
  return out;
}
