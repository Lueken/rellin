import { referencePath } from './station-artifacts.mjs';
import { openArtifact, systemOpenCommand } from './station-open.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function parseMouse(chunk) {
  const events = [];
  for (const match of String(chunk).matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const button = Number(match[1]), point = { x: Number(match[2]), y: Number(match[3]), ...(button & 16 ? { ctrl: true } : {}) };
    if (button & 64) { if (match[4] === 'M') events.push({ kind: 'wheel', delta: (button & 1) ? -3 : 3, ...point }); continue; }
    if ((button & 3) !== 0) continue;
    events.push({ kind: match[4] === 'm' ? 'release' : button & 32 ? 'drag' : 'press', ...point });
  }
  return events;
}

export function linkTarget(value, cwd, options = {}) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value) && /^https?:/i.test(value)) return null;
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return { kind: 'url', target: url.href }; } catch { return null; }
  }
  const file = referencePath(value, cwd, options);
  return file ? { kind: 'file', target: file } : null;
}

export function textLinks(text, cwd) {
  const links = [], occupied = [];
  const add = (start, end, value, options) => {
    if (occupied.some(range => start < range.end && end > range.start)) return;
    const target = linkTarget(value, cwd, options);
    // Invalid explicit links must not become a different bare path inside their label.
    occupied.push({ start, end });
    if (target) links.push({ start, end, ...target });
  };
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:\\.|[^\\()\n]|\([^()\n]*\))+?)\s*\)/g)) add(match.index, match.index + match[0].length, match[1].replace(/\s+["'][^"']*["']$/, '').replace(/^<(.*)>$/, '$1'), { link: true });
  for (const match of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) add(match.index, match.index + match[0].length, match[1], { wiki: true });
  for (const match of text.matchAll(/`([^`\n]+)`/g)) add(match.index, match.index + match[0].length, match[1]);
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const value = match[0].replace(/[.,;!]+$/, '').replace(/\)+$/, suffix => {
      const opens = (match[0].match(/\(/g) || []).length, closes = (match[0].match(/\)/g) || []).length;
      return suffix.slice(0, Math.max(0, suffix.length - Math.max(0, closes - opens)));
    });
    add(match.index, match.index + value.length, value);
  }
  for (const match of text.matchAll(/(?:^|[\s(])((?:[a-zA-Z]:[\\/]|\.{0,2}[\\/]|~[\\/])?[^\s<>"'`()[\]]+\.[a-zA-Z0-9]+(?::\d+(?::\d+)?|#[^\s<>"'`()\[\]]+)?)/g)) {
    const start = match.index + match[0].length - match[1].length;
    add(start, start + match[1].length, match[1]);
  }
  return links.sort((a, b) => a.start - b.start);
}

// xterm 5.5 exposes OSC 8 data only on internal cells/services. Isolate this
// optional adapter; plain paths/URLs still work if a future xterm changes it.
export function nativeLinkAt(terminal, row, col, cwd) {
  try {
    const id = terminal.buffer.active.getLine(row)?.getCell(col)?.extended?.urlId;
    const uri = id && terminal._core?._oscLinkService?.getLinkData(id)?.uri;
    return uri ? linkTarget(uri, cwd, { link: true }) : undefined;
  } catch { return undefined; }
}
export function terminalLinkAt(terminal, row, col, cwd) {
  const native = nativeLinkAt(terminal, row, col, cwd);
  if (native !== undefined) return native;
  const buffer = terminal.buffer.active;
  let start = row, end = row;
  while (start > 0 && row - start < 64 && buffer.getLine(start)?.isWrapped) start--;
  while (end - start < 64 && buffer.getLine(end + 1)?.isWrapped) end++;
  let text = '', offset = -1;
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x), width = cell?.getWidth() || 0;
      if (!width) continue;
      if (y === row && col >= x && col < x + width) offset = text.length;
      text += cell.getChars() || ' ';
    }
  }
  return textLinks(text, cwd).find(link => offset >= link.start && offset < link.end) || null;
}

export function wrappedLinkAt(text, width, row, col, cwd) {
  if (row < 0 || col < 0 || col >= width) return null;
  let offset = 0, currentRow = 0;
  for (const line of text.split('\n')) {
    const chars = [...line], count = Math.max(1, Math.ceil(chars.length / Math.max(1, width)));
    if (row < currentRow + count) {
      const at = (row - currentRow) * width + col;
      if (at >= chars.length) return null;
      offset += chars.slice(0, at).join('').length;
      return textLinks(text, cwd).find(link => offset >= link.start && offset < link.end) || null;
    }
    currentRow += count; offset += line.length + 1;
  }
  return null;
}

export async function openLink(link, { openFile = openArtifact, run = promisify(execFile) } = {}) {
  if (link?.kind === 'file') return openFile(link.target);
  const checked = link?.kind === 'url' && linkTarget(link.target, process.cwd());
  if (checked?.kind !== 'url') throw new Error('Only local files and HTTP(S) links can be opened.');
  const command = systemOpenCommand(checked.target);
  await run(command.file, command.args, { windowsHide: true, timeout: 10000, maxBuffer: 32768 });
  return { notice: `Open requested: ${checked.target}` };
}
