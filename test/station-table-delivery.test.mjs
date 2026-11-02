import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { prepareTableDelivery, TABLE_INLINE_BYTES } from '../station-table-delivery.mjs';

test('large Codex requests preserve exact Unicode context while bounding the native input', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station request '));
  const stationId = randomUUID(), requestId = randomUUID();
  const text = `Prior findings\n${'漢字 café 🧭\n'.repeat(1500)}\nStation table request ${requestId}`;
  const result = await prepareTableDelivery({ agent:'codex', text, stationId, requestId, dir });
  assert.ok(Buffer.byteLength(result.text) <= TABLE_INLINE_BYTES);
  assert.ok(!result.text.includes('\n'));
  assert.ok(result.text.includes(JSON.stringify(result.file)));
  assert.ok(result.text.endsWith(`Station table request ${requestId}`));
  assert.equal(await readFile(result.file, 'utf8'), text);
  assert.equal(result.sha256, createHash('sha256').update(text).digest('hex'));
  await assert.rejects(prepareTableDelivery({ agent:'codex', text:'different'.repeat(1000), stationId, requestId, dir }), /exist/i);
  assert.equal(await readFile(result.file, 'utf8'), text, 'a duplicate ID cannot overwrite a prior request');
});

test('short Codex openings also use a single line; Claude retains inline delivery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-inline-'));
  const text='short opening\nwith multiple lines';
  const result=await prepareTableDelivery({agent:'codex',text,dir,stationId:randomUUID(),requestId:randomUUID()});
  assert.ok(result.file); assert.ok(!result.text.includes('\n'));
  assert.equal(await readFile(result.file,'utf8'),text);
  const inline='long answer\n'.repeat(3000);
  assert.deepEqual(await prepareTableDelivery({agent:'claude',text:inline,dir}),{text:inline});
});

test('file preparation fails before delivery for invalid IDs or unwritable destinations', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-request-error-'));
  const args = {agent:'codex',text:'x'.repeat(11000),stationId:randomUUID(),requestId:randomUUID(),dir};
  await assert.rejects(prepareTableDelivery({...args, requestId:'../escape'}), /identity/);
  await writeFile(path.join(dir,'table-requests'), 'not a directory');
  await assert.rejects(prepareTableDelivery(args));
});
