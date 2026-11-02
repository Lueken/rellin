import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { artifactReferences, inspectArtifact, referencePath, loadFileSettings, saveFileSettings, DEFAULT_FILE_SETTINGS } from './station-artifacts.mjs';
import { openArtifact } from './station-open.mjs';
import { emphasizePosture } from './station-vocabulary.mjs';

const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const fields = ['markdown', 'html', 'vault', 'browser', 'editor'];
const names = { markdown: 'Markdown', html: 'HTML', vault: 'Existing vault folder', browser: 'Browser executable', editor: 'Text editor executable' };
const choices = { markdown: ['auto', 'system', 'obsidian'], html: ['browser', 'system'] };
function wrap(value, width) {
  const chars = [...clean(value)], lines = [];
  do { lines.push(chars.splice(0, Math.max(1, width)).join('')); } while (chars.length);
  return lines;
}
export function renderFiles(state, columns = 100, rows = 30) {
  const width = Math.max(10, Math.min(100, columns - 2)), inner = width - 4;
  const lines = [state.settingsOpen ? 'File opening settings' : `Files · ${clean(state.label || 'conversation')}`, ''];
  if (state.settingsOpen) {
    fields.forEach((name, i) => lines.push(`${i === state.field ? '>' : ' '} ${names[name]}: ${state.settings[name] || '(automatic)'}`));
    lines.push('', 'Auto Markdown uses Obsidian inside a vault; default app elsewhere.', 'Paths select existing apps/vaults. Files stay where they are.');
  } else {
    const capacity = Math.max(1, rows - 14), offset = Math.max(0, state.index - capacity + 1);
    const items = state.items.slice(offset, offset + capacity);
    if (!items.length) lines.push(state.busy ? 'Reading files…' : 'No local file references found. Press p to enter a path.');
    for (const [i, item] of items.entries()) lines.push(`${offset + i === state.index ? '>' : ' '} ${offset + i + 1} ${path.basename(item.file)} · ${item.available ? item.kind : 'unavailable'}`);
    lines.push('', ...wrap(state.items[state.index]?.file || state.cwd, inner).slice(-2));
    lines.push(`${state.items.length} references · ${state.limited ? 'recent history only' : 'loaded conversation'}`);
  }
  if (state.edit) lines.push('', `${state.edit === 'path' ? 'File path' : names[state.edit]}:`, ...wrap(state.input + '_', inner).slice(-2), 'Enter apply · Esc cancel');
  else lines.push('', state.settingsOpen ? '↑↓ field · Enter change · Esc back' : '↑↓ select · Enter open · p path · s settings · r refresh · Esc back');
  lines.push(...wrap(state.notice || '', inner).slice(0, 3));
  const body = lines.slice(0, Math.max(1, rows - 4));
  const top = Math.max(1, Math.floor((rows - body.length - 2) / 2) + 1), left = Math.max(1, Math.floor((columns - width) / 2) + 1);
  const frame = ['┌' + '─'.repeat(width - 2) + '┐', ...body.map(line => '│ ' + [...clean(line)].slice(0, inner).join('').padEnd(inner) + ' │'), '└' + '─'.repeat(width - 2) + '┘'];
  return '\x1b[?25l\x1b[0m' + frame.map((line, row) => `\x1b[${top + row};${left}H\x1b[48;5;236m\x1b[38;5;252m${emphasizePosture(line)}\x1b[0m`).join('');
}

export function showFiles({ cwd, label, read, redrawBackground = () => {}, dir, open = openArtifact }) {
  return new Promise(resolve => {
    let state = { cwd, label, items: [], index: 0, field: 0, settings: { ...DEFAULT_FILE_SETTINGS }, settingsOpen: false, edit: null, input: '', busy: false, notice: '', limited: false };
    let closed = false, settingsError = null;
    const draw = () => { if (!closed) { redrawBackground(); process.stdout.write(renderFiles(state, process.stdout.columns, process.stdout.rows)); } };
    const finish = (quit = false, notice = '') => {
      closed = true; process.stdin.removeListener('data', onData); process.stdout.removeListener('resize', draw); resolve({ quit, notice });
    };
    const refresh = async () => {
      state.busy = true; state.notice = ''; draw();
      try {
        const source = await read();
        const items = await Promise.all(artifactReferences(source.messages, cwd).map(item => inspectArtifact(item.file)));
        if (closed) return;
        state.items = items; state.index = 0; state.limited = source.limited;
      } catch (error) { state.notice = `${clean(error.message)} Press p to enter a file path.`; }
      finally { state.busy = false; draw(); }
    };
    const save = async next => {
      state.busy = true;
      try { state.settings = await saveFileSettings(next, dir); settingsError = null; state.notice = 'Settings saved.'; state.edit = null; }
      catch (error) { state.notice = clean(error.message); }
      finally { state.busy = false; draw(); }
    };
    const onData = async chunk => {
      if (chunk === '\x11') return finish(true);
      if (chunk === '\x1b') {
        if (state.edit) { state.edit = null; state.notice = ''; return draw(); }
        if (state.settingsOpen) { state.settingsOpen = false; return draw(); }
        return finish();
      }
      if (state.busy) return;
      if (state.edit) {
        if (chunk === '\r') {
          if (state.edit !== 'path') return save({ ...state.settings, [state.edit]: state.input.trim().replace(/^"(.*)"$/, '$1') });
          const file = referencePath(state.input.trim().replace(/^"(.*)"$/, '$1'), cwd);
          if (!file) { state.notice = 'Enter a local document, image, HTML, source, or diff file path.'; return draw(); }
          state.busy = true; const item = await inspectArtifact(file); state.busy = false;
          if (closed) return;
          state.items = [item, ...state.items.filter(existing => existing.file !== file)]; state.index = 0; state.edit = null; state.notice = item.error || 'Enter opens this file.'; return draw();
        }
        if (chunk === '\x7f' || chunk === '\b') state.input = [...state.input].slice(0, -1).join('');
        else if (chunk.startsWith('\x1b[200~')) state.input += clean(chunk.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, ''));
        else if (!/[\x00-\x1f\x7f-\x9f]/.test(chunk)) state.input += chunk;
        state.input = state.input.slice(0, 4096); return draw();
      }
      state.notice = '';
      if (chunk === '\x1b[A' || chunk === '\x1b[B') {
        const field = state.settingsOpen ? 'field' : 'index', length = state.settingsOpen ? fields.length : state.items.length;
        state[field] = Math.max(0, Math.min(length - 1, state[field] + (chunk === '\x1b[A' ? -1 : 1))); return draw();
      }
      if (state.settingsOpen) {
        if (chunk === '\r') {
          const field = fields[state.field];
          if (choices[field]) return save({ ...state.settings, [field]: choices[field][(choices[field].indexOf(state.settings[field]) + 1) % choices[field].length] });
          state.edit = field; state.input = state.settings[field];
        }
        return draw();
      }
      if (chunk === 's') { state.settingsOpen = true; state.notice = settingsError || ''; }
      if (chunk === 'p') { state.edit = 'path'; state.input = ''; }
      if (chunk === 'r') return refresh();
      if (chunk === '\r' && state.items[state.index]) {
        if (settingsError) { state.notice = `${settingsError} Press s to repair the settings.`; return draw(); }
        state.busy = true; state.notice = 'Opening…'; draw();
        try { const result = await open(state.items[state.index].file, { settings: state.settings, dir }); if (!closed) finish(false, result.notice); }
        catch (error) { state.notice = clean(error.message); }
        finally { state.busy = false; draw(); }
        return;
      }
      draw();
    };
    process.stdin.on('data', onData); process.stdout.on('resize', draw);
    state.busy = true; draw();
    void (async () => {
      try { state.settings = await loadFileSettings(dir); }
      catch (error) { settingsError = clean(error.message); }
      if (!closed) await refresh();
    })();
  });
}
