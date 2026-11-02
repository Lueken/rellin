import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, realpath, stat } from 'node:fs/promises';
import { LEDGER_HOME } from './station-ledger.mjs';
import { expandHome, saveJson, within } from './util.mjs';

const markdown = new Set(['.md', '.markdown']);
const html = new Set(['.html', '.htm']);
const media = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.pdf', '.docx', '.xlsx', '.pptx', '.mp3', '.wav', '.mp4', '.webm']);
const text = new Set(['.txt', '.diff', '.patch', '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml', '.log', '.xml', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.sql', '.sh', '.ps1']);
export const artifactKind = file => {
  const ext = path.extname(file).toLowerCase();
  return markdown.has(ext) ? 'markdown' : html.has(ext) ? 'html' : media.has(ext) ? 'document' : text.has(ext) ? 'text' : null;
};
const key = file => process.platform === 'win32' ? file.toLowerCase() : file;

export function referencePath(value, cwd, { link = false, wiki = false } = {}) {
  let input = String(value || '').trim().replace(/^<(.*)>$/, '$1');
  if (!input || /[\x00-\x1f\x7f]/.test(input)) return null;
  if (/^file:/i.test(input)) {
    try { const url = new URL(input); url.hash = ''; url.search = ''; input = fileURLToPath(url).replace(/:\d+(?::\d+)?$/, ''); } catch { return null; }
  } else {
    // Only local paths. A conversation cannot turn a link into a shell command or protocol action.
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) return null;
    if (wiki) input = input.split('|')[0];
    const hash = input.indexOf('#');
    if (hash >= 0 && (link || wiki || artifactKind(input.slice(0, hash)))) input = input.slice(0, hash);
    input = input.replace(/:\d+(?::\d+)?$/, '');
    if (link) { try { input = decodeURIComponent(input); } catch { return null; } }
    if (link && !/^(?:[a-z]:[\\/]|\\\\)/i.test(input)) input = input.replace(/\\([()[\] ])/g, '$1');
  }
  if (wiki && !path.extname(input)) input += '.md';
  if (!input || /[\x00-\x1f\x7f]/.test(input)) return null;
  const file = path.resolve(cwd, expandHome(input));
  return artifactKind(file) ? file : null;
}

export function artifactReferences(messages, cwd, limit = 200) {
  const found = new Map();
  const add = (raw, options) => {
    const file = referencePath(raw, cwd, options);
    if (file && !found.has(key(file)) && found.size < limit) found.set(key(file), { file, kind: artifactKind(file) });
  };
  // Newest messages first; preserve the ordering within each message.
  for (const message of [...messages].reverse()) {
    let body = String(message.text || '');
    body = body.replace(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:\\.|[^\\()\n]|\([^()\n]*\))+?)\s*\)/g, (_, value) => { add(value.replace(/\s+["'][^"']*["']$/, ''), { link: true }); return ' '; });
    body = body.replace(/^\s*\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm, (_, value) => { add(value, { link: true }); return ' '; });
    body = body.replace(/!?\[\[([^\]\n]+)\]\]/g, (_, value) => { add(value, { wiki: true }); return ' '; });
    body = body.replace(/`([^`\n]+)`/g, (_, value) => { add(value); return ' '; });
    for (const ref of message.imageRefs || []) add(ref);
    // Unquoted prose paths cannot contain spaces; use links or backticks for those.
    for (const match of body.matchAll(/(?:^|[\s(])((?:[a-zA-Z]:[\\/]|\.{0,2}[\\/]|~[\\/])?[^\s<>"'`()[\]]+\.[a-zA-Z0-9]+(?::\d+(?::\d+)?|#[^\s<>"'`()\[\]]+)?)/g)) add(match[1]);
  }
  return [...found.values()];
}

export async function inspectArtifact(file) {
  try {
    const actual = await realpath(file), info = await stat(actual);
    if (!info.isFile()) throw new Error('This path is not a file.');
    const kind = artifactKind(actual);
    if (!kind) throw new Error('This file type is not supported by the deliverable opener.');
    return { file, actual, kind, available: true };
  } catch (error) {
    return { file, kind: artifactKind(file), available: false, error: error.code === 'ENOENT' ? 'File not found. It may have moved or not been created yet.' : error.code === 'EACCES' ? 'This file is not readable.' : error.message };
  }
}

export const DEFAULT_FILE_SETTINGS = { markdown: 'auto', html: 'browser', vault: '', browser: '', editor: '' };
export function validateFileSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('File settings must be a JSON object.');
  const settings = { ...DEFAULT_FILE_SETTINGS, ...value };
  if (!['auto', 'system', 'obsidian'].includes(settings.markdown)) throw new Error('Markdown route must be auto, system, or obsidian.');
  if (!['browser', 'system'].includes(settings.html)) throw new Error('HTML route must be browser or system.');
  for (const name of ['vault', 'browser', 'editor']) {
    if (typeof settings[name] !== 'string' || /[\x00-\x1f\x7f]/.test(settings[name])) throw new Error(`Invalid ${name} path.`);
    if (settings[name]) {
      settings[name] = expandHome(settings[name]);
      if (!path.isAbsolute(settings[name])) throw new Error(`${name} must be an absolute path.`);
      settings[name] = path.normalize(settings[name]);
    }
  }
  return Object.fromEntries(Object.keys(DEFAULT_FILE_SETTINGS).map(name => [name, settings[name]]));
}
export const fileSettingsPath = (dir = LEDGER_HOME) => path.join(dir, 'station-files.json');
export async function loadFileSettings(dir) {
  try { return validateFileSettings(JSON.parse(await readFile(fileSettingsPath(dir), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_FILE_SETTINGS }; throw new Error(`Cannot read ${fileSettingsPath(dir)}: ${error.message}`); }
}
export async function saveFileSettings(settings, dir) {
  const checked = validateFileSettings(settings);
  for (const name of ['vault', 'browser', 'editor']) {
    if (!checked[name]) continue;
    const info = await stat(checked[name]).catch(() => null);
    if (name === 'vault' ? !info?.isDirectory() : !info?.isFile()) throw new Error(`${name} path does not exist or has the wrong type.`);
    if (name === 'vault' && !(await stat(path.join(checked.vault, '.obsidian')).catch(() => null))?.isDirectory()) throw new Error('Open this folder as a vault in Obsidian first, then select it here.');
  }
  await saveJson(fileSettingsPath(dir), checked);
  return checked;
}

async function containingVault(file, configured) {
  if (configured) {
    const root = await realpath(configured).catch(() => null);
    return root && within(root, file) && (await stat(path.join(root, '.obsidian')).catch(() => null))?.isDirectory() ? root : null;
  }
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if ((await stat(path.join(dir, '.obsidian')).catch(() => null))?.isDirectory()) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

export async function artifactTarget(file, settings = DEFAULT_FILE_SETTINGS) {
  settings = validateFileSettings(settings);
  const item = await inspectArtifact(file);
  if (!item.available) throw new Error(item.error);
  if (item.kind === 'markdown' && settings.markdown !== 'system') {
    const vault = await containingVault(item.actual, settings.vault);
    if (vault) return { ...item, route: 'obsidian', target: `obsidian://open?path=${encodeURIComponent(item.actual)}&paneType=tab` };
    if (settings.markdown === 'obsidian') throw new Error('This note is outside the selected Obsidian vault. Choose a containing vault in settings, or switch Markdown to system.');
  }
  if (item.kind === 'html' && settings.html === 'browser') return { ...item, route: 'browser', target: item.actual, executable: settings.browser };
  if (item.kind === 'text' || item.kind === 'markdown' && settings.editor && settings.markdown === 'auto') return { ...item, route: 'editor', target: item.actual, executable: settings.editor };
  return { ...item, route: 'system', target: item.actual };
}
