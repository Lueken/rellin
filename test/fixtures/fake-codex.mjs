import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { codexStore } from './codex-store.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--no-daemon'); process.exit(0); }
const claude = args.includes('--session-id');
const trace = data => appendFileSync(process.env.STATION_TEST_TRACE, JSON.stringify(data) + '\n');
const id = claude ? args[args.indexOf('--session-id') + 1] : args.includes('resume') ? args[args.indexOf('resume') + 1] : randomUUID();
trace({ type: 'launch', agent: claude ? 'claude' : 'codex', id, args });
let store, ordinal = 0, initialized = false;
const ready = () => process.stdout.write('\x1b[2J\x1b[HCODEX READY\r\n\r\n› Ask Codex to do anything\r\n\r\n  GPT-6-Astra high · ~/project\x1b[3;3H');
const reply = (text, answer) => {
  store ||= codexStore(process.env.CODEX_HOME);
  if (!initialized) {
    store.thread(id, process.platform === 'win32' ? path.toNamespacedPath(process.cwd()) : process.cwd(), process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE.replace('mrmak_chat_', ''));
    initialized = true;
  }
  store.turn(id, randomUUID(), 'completed', ordinal, text, answer); ordinal += 2;
  console.log('CODEX RESPONSE');
  ready();
};
if (!claude && args.some(arg => arg.startsWith('Continue the work from'))) reply('continuation', 'Ready to continue');
console.log(claude ? 'CLAUDE READY' : 'CODEX READY');
if (!claude) ready();
process.stdin.setRawMode?.(true); process.stdin.resume();
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  if (!input.includes('\r')) return;
  const text = input.replace(/\x1b\[200~|\x1b\[201~|\r/g, ''); input = '';
  trace({ type: 'input', agent: claude ? 'claude' : 'codex', text });
  if (claude) return;
  if (text === '/model') { console.log('CODEX LOCAL MODEL MENU'); return; }
  if (text === '2') { ready(); return; }
  const match = /Station handoff request ([a-f0-9-]+)/.exec(text);
  if (!match) return reply(text, 'Initial answer');
  const summary = '# Handoff\n' + ['Goal', 'Current state', 'Decisions', 'Files', 'Open problems', 'Next steps'].map(heading => `## ${heading}\nDetails`).join('\n') + `\n<!-- station-handoff:${match[1]}:end -->`;
  reply(text, summary);
});
