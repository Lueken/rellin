import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createInputFramer, installInputFraming } from '../station-input.mjs';

test('coalesced focus, editing, mouse and clipboard input retain their order', () => {
  const parts=[], decoder=createInputFramer(part=>parts.push(part));
  decoder.write('\x1b1\x03\x1b2hello\x7f\x7fZ\x1b[<0;4;5m\x1bv');
  assert.deepEqual(parts,['\x1b1','\x03','\x1b2','hello','\x7f','\x7f','Z','\x1b[<0;4;5m','\x1bv']);
  decoder.dispose();
});

test('split CSI, arrows and bracketed paste are kept intact; paste cannot invoke shortcuts', () => {
  const parts=[], decoder=createInputFramer(part=>parts.push(part));
  decoder.write('\x1b[');decoder.write('A\t\x1bO');decoder.write('P\x1b[20');
  decoder.write('0~first\n\x11\x1bs\x7f');decoder.write('last\x1b[201');decoder.write('~\r');
  assert.deepEqual(parts,['\x1b[A','\t','\x1bOP','\x1b[200~first\n\x11\x1bs\x7flast\x1b[201~','\r']);
  decoder.dispose();
});

test('lone Escape is delivered, while a split Alt chord is reassembled', async () => {
  const parts=[], decoder=createInputFramer(part=>parts.push(part),{escapeMs:10});
  decoder.write('\x1b');decoder.write('s');assert.deepEqual(parts,['\x1bs']);
  decoder.write('\x1b');await delay(30);assert.deepEqual(parts,['\x1bs','\x1b']);decoder.dispose();
});

test('a newly opened modal receives the rest of a combined packet and cleanup restores input', () => {
  const input=new EventEmitter(), original=input.emit, parts=[];
  const release=installInputFraming(input);
  const main=part=>{parts.push('main:'+part);input.off('data',main);input.on('data',part=>parts.push('modal:'+part));};
  input.on('data',main);input.emit('data','\x1bs\t\x1b[C\r');
  assert.deepEqual(parts,['main:\x1bs','modal:\t','modal:\x1b[C','modal:\r']);
  release();assert.equal(input.emit,original);
});

test('abandoned escape prefixes cannot swallow quit or trap later typing', async () => {
  const parts=[], decoder=createInputFramer(part=>parts.push(part),{escapeMs:10});
  decoder.write('\x1b[');decoder.write('\x11');
  assert.deepEqual(parts,['\x1b[','\x11']);
  decoder.write('\x1bO');await delay(30);decoder.write('text');
  assert.deepEqual(parts,['\x1b[','\x11','\x1bO','text']);decoder.dispose();
});
