import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { showFiles } from '../../station-files.mjs';
import { openArtifact } from '../../station-open.mjs';

if (process.argv.includes('--ui')) {
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  const root = process.env.STATION_HOME, trace = path.join(root, 'open.json');
  let attempts = 0;
  const result = await showFiles({ cwd: root, dir: root, label: 'fixture',
    read: async () => ({ messages: [{ text: '[Note](note.md) [Interactive report](report.html)' }], limited: false }),
    redrawBackground: () => process.stdout.write('\x1b[2J\x1b[HAGENT STILL VISIBLE'),
    open: (file, options) => openArtifact(file, { ...options,
      command: async target => ({ route: target.route, target: target.target }),
      run: async command => { if (++attempts === 1) throw new Error('fixture app unavailable'); await writeFile(trace, JSON.stringify(command)); },
    }),
  });
  console.log('FILES CLOSED', result.notice); process.exit(0);
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-files-pty-'));
  await mkdir(path.join(root, '.obsidian')); await writeFile(path.join(root, 'note.md'), '# Note'); await writeFile(path.join(root, 'report.html'), '<h1>Report</h1>');
  const proc = pty.spawn(process.execPath, [fileURLToPath(import.meta.url), '--ui'], { cwd: process.cwd(), env: { ...process.env, STATION_HOME: root }, cols: 120, rows: 35 });
  let output = '', exited = false;
  proc.onData(data => { output += data; }); proc.onExit(() => { exited = true; });
  const waitFor = async value => { for (let i = 0; i < 100 && !output.includes(value) && !exited; i++) await delay(100); assert.ok(output.includes(value), `Missing ${value}: ${output.slice(-1600)}`); output = ''; };
  try {
    await waitFor('note.md');
    proc.write('\r'); await waitFor('fixture app unavailable');
    proc.write('s'); await waitFor('File opening settings');
    proc.write('\x1b[B'); await waitFor('> HTML: browser');
    proc.write('\r'); await waitFor('Settings saved.');
    proc.write('\r'); await waitFor('Settings saved.');
    proc.write('\x1b'); await waitFor('note.md');
    proc.write('\x1b[B'); await waitFor('> 2 report.html');
    proc.write('\r'); await waitFor('FILES CLOSED');
    const opened = JSON.parse(await readFile(path.join(root, 'open.json'), 'utf8'));
    assert.equal(opened.route, 'browser'); assert.equal(opened.target, path.join(root, 'report.html'));
    const settings = JSON.parse(await readFile(path.join(root, 'station-files.json'), 'utf8'));
    assert.equal(settings.html, 'browser');
    console.log('Files lifecycle passed');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { if (!exited) proc.kill(); }
  process.exit(process.exitCode || 0);
}
