import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LEDGER_HOME } from './station-ledger.mjs';

// Windows Codex multiline pastes can swallow Enter even after output settles,
// including short opening prompts. Every Codex request uses one short line.
// Bound the terminal payload; retain the complete request as a local artifact.
export const TABLE_INLINE_BYTES = 2000;
export async function prepareTableDelivery({ agent, text, requestId, stationId, dir = LEDGER_HOME }) {
  if (agent !== 'codex') return { text };
  if (![requestId, stationId].every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id))) throw new Error('Invalid table request identity.');
  const folder = path.resolve(dir, 'table-requests', stationId);
  const file = path.join(folder, `${requestId}.md`);
  const delivered = `Read the complete Station table request from this UTF-8 file (JSON-encoded path): ${JSON.stringify(file)}. Follow its instructions and answer in this conversation. Read the entire file before answering; if it is inaccessible, report that and do not guess. Station table request ${requestId}`;
  if (Buffer.byteLength(delivered, 'utf8') > TABLE_INLINE_BYTES) throw new Error('The table request path is too long for a bounded terminal delivery.');
  await mkdir(folder, { recursive: true });
  await writeFile(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { text: delivered, file, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}
