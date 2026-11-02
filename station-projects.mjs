// Adapted from Saddlepoint's recent-projects.mjs. Discovery only reads provider
// folder metadata; Rellin's pins live in its own data directory.
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexProjects } from './codex-history.mjs';
import { LEDGER_HOME } from './station-ledger.mjs';
import { expandHome, readJson, saveJson } from './util.mjs';

export const projectKey = folder => process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder);
const transient = folder => folder.split(/[\\/]/).some(part => ['.claude', '.codex', 'scratch-workspaces'].includes(part));

export async function claudeProjects(env = process.env) {
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const config = await readJson(env.CLAUDE_CONFIG_DIR ? path.join(home, '.claude.json') : path.join(os.homedir(), '.claude.json'), {});
  const projects = config?.projects && typeof config.projects === 'object' && !Array.isArray(config.projects) ? Object.keys(config.projects) : [];
  const root = path.join(home, 'projects');
  const folders = new Map((await readdir(root).catch(() => [])).map(name => [name.toLowerCase(), name]));
  return Promise.all(projects.map(async folder => {
    const name = folders.get(folder.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase());
    const info = name ? await stat(path.join(root, name)).catch(() => null) : null;
    return { path: folder, source: 'claude', at: info?.mtime.toISOString() || null };
  }));
}

export async function loadPins(dir = LEDGER_HOME) {
  const value = await readJson(path.join(dir, 'station-projects.json'), {});
  return Array.isArray(value.pinned) ? value.pinned.filter(item => typeof item === 'string' && path.isAbsolute(item)) : [];
}

export async function savePins(pinned, dir = LEDGER_HOME) {
  await saveJson(path.join(dir, 'station-projects.json'), { pinned: [...new Map(pinned.map(folder => [projectKey(folder), path.resolve(folder)])).values()] });
}

export async function resolveProject(input, base = process.cwd()) {
  const value = input.trim().replace(/^"(.*)"$/, '$1');
  if (!value || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('Enter a folder path.');
  const folder = path.resolve(base, expandHome(value));
  if (!(await stat(folder).catch(() => null))?.isDirectory()) throw new Error(`Folder does not exist: ${folder}`);
  return folder;
}

export async function recentProjects({ cwd, runs = [], pinned = [], sources } = {}) {
  const discovered = sources ?? (await Promise.all([claudeProjects(), codexProjects().catch(() => [])])).flat();
  const candidates = [
    { path: cwd, source: 'current' },
    ...pinned.map(folder => ({ path: folder, source: 'pinned' })),
    ...runs.map(run => ({ path: run.cwd, source: 'station', at: run.started_at })),
    ...discovered,
  ];
  const projects = new Map();
  for (const item of candidates) {
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path) || /[\x00-\x1f\x7f-\x9f]/.test(item.path)) continue;
    // Explicit current folders and pins remain available, including worktrees.
    if (transient(item.path) && !['current', 'pinned'].includes(item.source)) continue;
    const key = projectKey(item.path);
    const project = projects.get(key) || { path: path.resolve(item.path), name: path.basename(path.resolve(item.path)) || item.path, sources: [], pinned: false, lastUsedAt: null, sessions: runs.filter(run => projectKey(run.cwd) === key).length };
    if (item.source === 'pinned') project.pinned = true;
    else if (!project.sources.includes(item.source)) project.sources.push(item.source);
    if (item.at && (!project.lastUsedAt || item.at > project.lastUsedAt)) project.lastUsedAt = item.at;
    projects.set(key, project);
  }
  const existing = await Promise.all([...projects.values()].map(async item => (await stat(item.path).catch(() => null))?.isDirectory() ? item : null));
  return existing.filter(Boolean).sort((a, b) => Number(b.sources.includes('current')) - Number(a.sources.includes('current')) || Number(b.pinned) - Number(a.pinned) || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')) || a.name.localeCompare(b.name)).slice(0, 100);
}
