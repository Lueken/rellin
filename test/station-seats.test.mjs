import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { nextSeatName, removedSeatNavigation, seatMutationGuard, renderSeatManager } from '../station-seats.mjs';
import { keyAction, reduce, decorateSeats } from '../station.mjs';
import { openLedger, readLedger } from '../station-ledger.mjs';
import { loadHistory } from '../station-history.mjs';

test('seat removal remaps addresses and preserves survivor names across resume', () => {
  const seats = [{ agent: 'claude', seat: 'claude-2', mode: 'manual' }];
  assert.equal(nextSeatName('claude', seats), 'claude');
  assert.equal(decorateSeats(seats)[0].seat, 'claude-2');
  assert.deepEqual(removedSeatNavigation({ focus: 2, address: [0, 2], view: 'zoom' }, 0, 2), { focus: 1, address: [1], view: 'zoom', composer: null, selection: null });
  assert.deepEqual(removedSeatNavigation({ focus: 1, address: [1], view: 'table' }, 1, 1), { focus: 0, address: [0], view: 'console', composer: null, selection: null });
  assert.equal(removedSeatNavigation({ focus: 0, address: 'all', view: 'gallery' }, 0, 1).address, 'all');
});

test('seat operations respect active discussions, handoffs, pending paste and lineup limits', () => {
  for (const flag of ['tableActive', 'handoffPending', 'busy']) assert.throws(() => seatMutationGuard({ count: 2, operation: 'restart', [flag]: true }));
  assert.throws(() => seatMutationGuard({ count: 4, operation: 'add' }), /four/);
  assert.throws(() => seatMutationGuard({ count: 1, operation: 'close' }), /one seat/);
  assert.doesNotThrow(() => seatMutationGuard({ count: 1, operation: 'restart' }));
});

test('Alt+S opens a compact manager without leaking into agent input or a composer', () => {
  const state = { seats: [{ seat: 'claude', alive: true }], composer: null };
  assert.deepEqual(reduce(state, keyAction('\x1bs', state))[1], [{ type: 'seats' }]);
  assert.equal(keyAction('\x1bs', { ...state, composer: { text: '' } }).type, 'none');
  const output = renderSeatManager({ index: 0 }, state.seats, 100, 30);
  assert.match(output, /Manage seats/); assert.ok(!output.includes('\x1b[2J'));
});

test('closing a seat archives its identity and commits the surviving lineup and event together', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-seats-'));
  const first = { agent: 'claude', seat: 'claude', nativeId: 'first' }, second = { agent: 'codex', seat: 'codex', nativeId: 'second', attention: { unread: true } };
  const ledger = await openLedger({ cwd: dir, dir, repo: { root: null, remote: null }, name: 'Work', seats: [first, second] });
  const archiveId = ledger.removeSeat(0);
  ledger.changeSeats([second, first], { type: 'seat-added', seat: first.seat });
  assert.throws(() => ledger.changeSeats([], { type: 'seat-added' }));
  ledger.close();
  const history = loadHistory({ dir });
  assert.deepEqual(history.find(run => run.id === ledger.id).seats, [second, first]);
  const archive = history.find(run => run.id === archiveId);
  assert.equal(archive.active, false); assert.equal(archive.seats[0].nativeId, 'first');
  assert.equal(archive.seats[0].closedFrom, ledger.id);
  const read = readLedger(path.join(dir, 'station.db'));
  assert.deepEqual(read.events(ledger.id).filter(event => event.type.startsWith('seat-')).map(event => event.type), ['seat-closed', 'seat-added']);
  read.close();
});
