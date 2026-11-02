import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { claudeProjects, loadPins, recentProjects, resolveProject, savePins } from '../station-projects.mjs';
import { initialStartup, renderStartup, startupItems, startupKey, startupReduce } from '../station-startup.mjs';

const state = (extra = {}) => ({ page: 'projects', project: null, index: 0, query: '', edit: null, text: '', notice: null, ...extra });
const folder = path.resolve('fixture-project');
const run = (id, extra = {}) => ({ id, cwd: folder, name: `Task ${id}`, started_at: '2026-10-29T12:00:00Z', seats: [{ agent: 'claude', nativeId: 'native' }], ...extra });
const data = { cwd: folder, projects: [{ path: folder, name: 'fixture-project', sessions: 3 }], runs: [run('first'), run('second', { active: true }), run('third', { seats: [{ agent: 'claude' }] })] };

test('Enter resumes the newest resumable run in the current folder, skipping active and legacy runs', () => {
  const d = { ...data, runs: [run('active',{active:true,started_at:'2026-10-31'}), run('older'), run('newest',{started_at:'2026-10-30'}), run('elsewhere',{cwd:path.resolve('elsewhere'),started_at:'2026-11-01'})] };
  const s = initialStartup(d);
  assert.equal(s.page,'sessions'); assert.equal(s.project,folder);
  assert.equal(startupReduce(s,{type:'open'},d)[1].run.id,'newest');
  assert.equal(initialStartup({...data,runs:[]}).page,'projects');
});

test('project -> sessions -> resume; active and legacy rows explain why they cannot resume', () => {
  let [s] = startupReduce(state(), { type: 'open' }, data);
  assert.equal(s.page, 'sessions');
  assert.equal(s.project, folder);
  assert.equal(startupReduce(s, { type: 'open' }, data)[1].run.id, 'first');
  [s] = startupReduce(s, { type: 'move', delta: 1 }, data);
  assert.match(startupReduce(s, { type: 'open' }, data)[0].notice, /active/);
  [s] = startupReduce(s, { type: 'move', delta: 1 }, data);
  assert.match(startupReduce(s, { type: 'open' }, data)[0].notice, /older run/);
  assert.equal(startupReduce(s, { type: 'back' }, data)[0].page, 'projects');
});

test('search, naming, paste and navigation preserve the selected working folder', () => {
  let [s] = startupReduce(state(), { type: 'new' }, data);
  assert.equal(s.edit, 'name');
  [s] = startupReduce(s, startupKey('Terrain review', s), data);
  assert.deepEqual(startupReduce(s, { type: 'submit' }, data)[1], { type: 'new', cwd: folder, name: 'Terrain review' });
  assert.equal(startupKey('\x1b', s).type, 'back');
  assert.equal(startupKey('\x11', s).type, 'quit');
  assert.equal(startupKey('q', s).type, 'text', 'q is ordinary text when naming');
  s = state({ page: 'sessions', edit: 'search' });
  [s] = startupReduce(s, startupKey('\x1b[200~second\x1b[201~', s), data);
  assert.deepEqual(startupItems(s, data).map(item => item.id), ['second']);
  assert.equal(startupReduce(s, { type: 'back' }, data)[0].query, '');
});

test('small terminal list scrolls to the selected item and clips untrusted labels', () => {
  const projects = Array.from({ length: 40 }, (_, i) => ({ path: folder, name: `project-${i}\x1b[2J`, sessions: i }));
  const lines = renderStartup(state({ index: 30 }), { ...data, projects }, 50, 20);
  assert.ok(lines.some(line => line.includes('project-30')));
  assert.ok(lines.length <= 20);
  assert.ok(lines.every(line => line.length < 50 && !line.includes('\x1b')));
});

test('empty session lists still allow new work in the chosen project', () => {
  const s = state({ page: 'sessions', project: folder });
  assert.equal(startupReduce(s, { type: 'new' }, { ...data, runs: [] })[0].newCwd, folder);
  assert.match(renderStartup(s, { ...data, runs: [] }).join('\n'), /No matching sessions/);
});

test('discovery merges provider metadata, pins and Rellin history; missing folders are excluded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-projects-'));
  const current = path.join(root, 'current'), favorite = path.join(root, 'favorite'), recent = path.join(root, 'recent');
  await Promise.all([current, favorite, recent].map(folder => mkdir(folder)));
  const projects = await recentProjects({ cwd: current, pinned: [favorite], runs: [{ cwd: recent, started_at: '2026-10-29' }], sources: [{ path: recent, source: 'codex', at: '2026-10-28' }, { path: path.join(root, 'missing'), source: 'claude' }] });
  assert.deepEqual(projects.map(item => item.path), [current, favorite, recent]);
  assert.equal(projects[1].pinned, true);
  assert.equal(projects[2].sessions, 1);
  assert.deepEqual(projects[2].sources, ['station', 'codex']);
  await savePins([favorite, favorite], root);
  assert.deepEqual(await loadPins(root), [favorite]);
  assert.equal(await resolveProject('"favorite"', root), favorite);
  await assert.rejects(resolveProject('missing', root), /does not exist/);
  await savePins([], root);
  assert.deepEqual(await loadPins(root), []);
});

test('Claude discovery exposes only project paths, never other config values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-claude-projects-'));
  await writeFile(path.join(root, '.claude.json'), JSON.stringify({ projects: { [folder]: { private: 'secret' } }, token: 'credential' }));
  const result = await claudeProjects({ CLAUDE_CONFIG_DIR: root });
  assert.deepEqual(result, [{ path: folder, source: 'claude', at: null }]);
  assert.doesNotMatch(JSON.stringify(result), /secret|credential/);
});
