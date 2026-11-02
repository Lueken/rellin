import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { artifactReferences, referencePath, inspectArtifact, artifactTarget, loadFileSettings, saveFileSettings, fileSettingsPath, DEFAULT_FILE_SETTINGS } from '../station-artifacts.mjs';
import { openArtifact, openingCommand, systemOpenCommand, browserExecutable } from '../station-open.mjs';
import { renderFiles } from '../station-files.mjs';
import { conversationKey } from '../station-conversation.mjs';
import { keyAction, reduce, stationSeats } from '../station.mjs';

test('file references cover links, spaces, encoded names, wiki notes, images, code paths and line suffixes', () => {
  const cwd = process.cwd(), absolute = path.join(cwd, 'docs', 'report (final).md');
  const messages = [{ text: '[old](old.md)' }, { text: `[Report](<${absolute}:12>)\n[HTML](reports/result%20one.html "Report")\n[Diagram][d]\n[d]: assets/chart.svg\n[[Notes/Decision|decision]]\n\`src/file.cpp:42:2\` and \`folder/with spaces.md\`\n[Report again](<${absolute}>)\nSee ./changes.diff and report.pdf.\n[external](https://example.com/page.html) [bad](javascript:alert(1))`, imageRefs: ['assets/image.png'] }];
  const refs = artifactReferences(messages, cwd).map(item => path.relative(cwd, item.file).replaceAll('\\', '/'));
  assert.deepEqual(new Set(refs), new Set(['docs/report (final).md', 'reports/result one.html', 'assets/chart.svg', 'Notes/Decision.md', 'src/file.cpp', 'folder/with spaces.md', 'assets/image.png', 'changes.diff', 'report.pdf', 'old.md']));
  assert.equal(refs.length, 10, 'no duplicate or spurious fragments from paths with spaces');
  assert.equal(referencePath('notes/a%23b.md', cwd, { link: true }), path.join(cwd, 'notes/a#b.md'));
  assert.equal(referencePath('notes/a#b.md', cwd), path.join(cwd, 'notes/a#b.md'));
  assert.equal(referencePath(pathToFileURL(absolute).href + '#Heading', cwd), absolute);
  assert.equal(referencePath(pathToFileURL(absolute).href + ':12:3', cwd), absolute);
  assert.equal(referencePath('obsidian://new?content=untrusted', cwd), null);
  assert.equal(referencePath('run.exe', cwd), null);
  assert.equal(referencePath('bad\nname.md', cwd), null);
});

test('Markdown routing uses existing containing vaults and never moves or duplicates notes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-files-'));
  const vault = path.join(root, 'Vault'), note = path.join(vault, 'A & B #1.md'), outside = path.join(root, 'outside.md');
  await mkdir(path.join(vault, '.obsidian'), { recursive: true }); await writeFile(note, 'hello'); await writeFile(outside, 'outside');
  const target = await artifactTarget(note);
  assert.equal(target.route, 'obsidian');
  assert.equal(new URL(target.target).searchParams.get('path'), note);
  assert.equal(new URL(target.target).searchParams.get('paneType'), 'tab');
  assert.equal((await artifactTarget(outside)).route, 'system');
  assert.equal((await artifactTarget(note, { markdown: 'system' })).route, 'system');
  assert.equal((await artifactTarget(note, { markdown: 'system', editor: process.execPath })).route, 'system');
  await assert.rejects(artifactTarget(outside, { markdown: 'obsidian', vault }), /outside/);
  assert.equal(await readFile(note, 'utf8'), 'hello');
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('settings persist in Rellin home, validate paths, and report malformed configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-files-'));
  assert.deepEqual(await loadFileSettings(root), DEFAULT_FILE_SETTINGS);
  await saveFileSettings({ markdown: 'system', html: 'system' }, root);
  assert.equal((await loadFileSettings(root)).html, 'system');
  await assert.rejects(saveFileSettings({ vault: root }, root), /Open this folder as a vault/);
  assert.equal((await loadFileSettings(root)).markdown, 'system', 'failed settings save leaves previous configuration intact');
  await writeFile(fileSettingsPath(root), '{broken');
  await assert.rejects(loadFileSettings(root), /Cannot read/);
});

test('opening rechecks missing and unsupported files and routes scripts/diffs to an editor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-files-'));
  const html = path.join(root, 'report.html'), script = path.join(root, 'example.ps1'), diff = path.join(root, 'changes.diff');
  for (const file of [html, script, diff]) await writeFile(file, 'fixture');
  assert.equal((await artifactTarget(html)).route, 'browser');
  assert.equal((await artifactTarget(html, { html: 'system' })).route, 'system');
  assert.equal((await artifactTarget(script)).route, 'editor');
  assert.equal((await artifactTarget(diff)).route, 'editor');
  const executable = path.join(root, 'danger.exe'); await writeFile(executable, 'fixture');
  let launched = false;
  await assert.rejects(openArtifact(executable, { settings: {}, run: async () => { launched = true; } }), /not supported/);
  await assert.rejects(openArtifact(path.join(root, 'missing.md'), { settings: {}, run: async () => { launched = true; } }), /not found/);
  assert.equal(launched, false);
  assert.equal((await inspectArtifact(root)).available, false);
  const command = await openingCommand({ route: 'editor', target: diff, executable: process.execPath });
  assert.deepEqual(command.args, [diff]);
});

test('external opens use literal argv or quoted PowerShell values and show launcher failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-files-'));
  const file = path.join(root, "report '$() & review.html"); await writeFile(file, '<html>fixture</html>');
  let received;
  const result = await openArtifact(file, { settings: { browser: process.execPath }, run: async command => { received = command; } });
  assert.equal(received.file, process.execPath);
  assert.deepEqual(received.args, [pathToFileURL(file).href]);
  assert.equal(result.route, 'browser');
  const encoded = systemOpenCommand(file, 'win32');
  const script = Buffer.from(encoded.args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes("report ''$() & review.html'"));
  assert.equal(browserExecutable('"C:\\Browser App\\browser.exe" --single-argument "%1"'), 'C:\\Browser App\\browser.exe');
  assert.equal(browserExecutable('powershell -Command bad'), null);
  await assert.rejects(openArtifact(file, { settings: {}, command: async () => ({}), run: async () => { throw new Error('app unavailable'); } }), /app unavailable/);
});

test('file shortcuts stay out of agent input and the picker paints a bounded popup', () => {
  const state = { seats: stationSeats('claude'), focus: 0, composer: null };
  assert.deepEqual(reduce(state, keyAction('\x1bo', state))[1], [{ type: 'files' }]);
  assert.equal(conversationKey('f', {}).type, 'files');
  assert.equal(conversationKey('f', { searching: true }).type, 'text');
  const output = renderFiles({ cwd: process.cwd(), label: 'claude', items: [], index: 0, settings: DEFAULT_FILE_SETTINGS }, 120, 35);
  assert.ok(!output.includes('\x1b[2J'));
  assert.ok(output.includes('No local file references'));
  assert.ok([...output.matchAll(/\x1b\[(\d+);(\d+)H/g)].every(match => Number(match[1]) > 1 && Number(match[1]) < 35 && Number(match[2]) > 1));
});
