import test from 'node:test';
import assert from 'node:assert/strict';
import { activityBuckets, activitySparkline } from '../station-activity.mjs';
import { openLedger } from '../station-ledger.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const state = activity => ({ lifecycle: 'running', activity, source: 'native', watcher: { state: 'healthy' } });
test('activity buckets preserve missing evidence, native idle and observed working intervals', () => {
  assert.equal(activitySparkline(activityBuckets([], 120000)), '········');
  assert.equal(activitySparkline(activityBuckets([{ at: 0, snapshot: state('idle') }], 120000)), '▁▁▁▁▁▁▁▁');
  const series = [{ at: 0, snapshot: state('idle') }, { at: 15000, snapshot: state('working') }, { at: 37500, snapshot: state('completed') }, { at: 60000, snapshot: { ...state('idle'), watcher: { state: 'error' } } }, { at: 90000, snapshot: state('idle') }];
  assert.deepEqual(activityBuckets(series, 120000), [0, 1, .5, 0, null, null, 0, 0]);
  assert.equal(activitySparkline(activityBuckets([{ at: 10000, snapshot: state('working') }], 15000)).at(-1), '·');
  assert.equal(activitySparkline(activityBuckets([{ at: 0, snapshot: { ...state('working'), source: 'input' } }], 120000)), '········');
});

test('ledger activity reads incrementally without mutating snapshots and retains the window seed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'station-activity-'));
  const ledger = await openLedger({ cwd: dir, dir, seats: [{ seat: 'claude' }], repo: { root: null, remote: null } });
  try {
    ledger.attention(0, state('working'), 'turn-started');
    const first = ledger.activitySeries(0);
    first.get('claude')[0].snapshot.activity = 'mutated';
    ledger.attention(0, state('completed'), 'completed');
    assert.deepEqual(ledger.activitySeries(0).get('claude').map(item => item.snapshot.activity), ['working', 'completed']);
    assert.equal(ledger.activitySeries(Date.now() + 1).get('claude').length, 1);
    assert.equal(ledger.activitySeries(Date.now() + 1).get('claude')[0].snapshot.activity, 'completed');
  } finally { ledger.close(); }
});
