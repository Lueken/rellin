import test from 'node:test';
import assert from 'node:assert/strict';
import { composeBlindPrompt, composeFloorPrompt, renderTable, tableReduce } from '../station-table.mjs';
import { finalAssistantText, parseRecords } from '../station-turns.mjs';
import headless from '@xterm/headless';
import { displayWidth } from '../station-markdown.mjs';

const SEATS = [
  { seat: 'claude', agent: 'claude', model: 'opus', status: 'ready', alive: true, color: '#dba68c' },
  { seat: 'codex', agent: 'codex', model: 'gpt-6', status: 'ready', alive: true, color: '#88d8bf' },
  { seat: 'claude-2', agent: 'claude', model: 'default', status: 'ready', alive: true, color: '#e8c66a' },
];
const sends = effects => effects.filter(effect => effect.type === 'send');
const start = () => tableReduce(null, { type: 'table-start', topic: 'Which engine?', members: [0, 1, 2], maxRounds: 3, at: 1000 }, SEATS);

test('pasted wide and combining characters wrap by cells and keep the caret after the tail', async () => {
  for (const width of [50, 83]) {
    const height = 24, x = 26, input = 'ASCII 漢字 cafe\u0301 '.repeat(50) + '漢字e\u0301';
    const terminal = new headless.Terminal({ cols: width + x + 1, rows: height + 1, allowProposedApi: true });
    const painted = renderTable({ table: null, ui: { input, scroll: 0 }, seats: SEATS, width, height, x, shelf: true, colorOf: () => '', now: 0 });
    await new Promise(resolve => terminal.write(painted, resolve));
    const buffer = terminal.buffer.active;
    const tail = buffer.getLine(buffer.cursorY).translateToString(true).trimEnd();
    assert.ok(tail.normalize('NFC').endsWith('漢字é'), 'last graphemes remain intact');
    assert.equal(buffer.cursorX, displayWidth(tail), 'cursor measures rendered cells rather than UTF-16 units');
    assert.equal(buffer.cursorY, height - 3);
    terminal.dispose();
  }
});

test('held unsent openings retain peer answers; retry sends only missing seats', () => {
  let [table] = start();
  [table] = tableReduce(table, { type: 'hold', seat: 1, reason: 'menu', at: 1100 }, SEATS);
  for (const seat of [0, 2]) [table] = tableReduce(table, { type: 'answer', seat, text: `answer ${seat}`, at: 1500 }, SEATS);
  assert.equal(table.phase, 'held');
  assert.deepEqual(Object.keys(table.staged), ['0', '2']);
  let effects;
  [table, effects] = tableReduce(table, { type: 'retry', at: 2000 }, SEATS);
  assert.deepEqual(sends(effects).map(e => e.seat), [1]);
  [table] = tableReduce(table, { type: 'answer', seat: 1, text: 'answer 1', at: 2500 }, SEATS);
  assert.equal(table.round, 2);
  assert.equal(table.entries.filter(e => e.speaker !== 'chair').length, 3);
});

test('retrying a held floor step retains unseen peer context and interjections', () => {
  let [table] = start();
  for (const seat of [0, 1, 2]) [table] = tableReduce(table, { type: 'answer', seat, text: `evidence ${seat}`, at: 1500 }, SEATS);
  [table] = tableReduce(table, { type: 'hold', seat: 0, reason: '/usage', at: 1600 }, SEATS);
  [table] = tableReduce(table, { type: 'interject', text: 'New chair evidence', at: 1700 }, SEATS);
  const [resumed, effects] = tableReduce(table, { type: 'retry', at: 2000 }, SEATS);
  assert.equal(resumed.round, 2); assert.equal(resumed.phase, 'floor');
  assert.equal(sends(effects).length, 1);
  for (const text of ['evidence 0', 'evidence 1', 'evidence 2', 'New chair evidence']) assert.ok(sends(effects)[0].text.includes(text));
  const [ended] = tableReduce(table, { type: 'end', at: 2100 }, SEATS);
  assert.equal(sends(tableReduce(ended, { type: 'retry', at: 2200 }, SEATS)[1]).length, 0);
});

test('round 1 is blind: all prompted at once, nothing released until the last answer', () => {
  let [table, effects] = start();
  assert.equal(sends(effects).length, 3);
  assert.equal(table.phase, 'blind');
  // Blind prompts never contain another seat's text.
  assert.doesNotMatch(sends(effects)[0].text, /Since your last turn/);
  [table] = tableReduce(table, { type: 'answer', seat: 0, text: 'A says X', at: 2000 }, SEATS);
  [table] = tableReduce(table, { type: 'answer', seat: 2, text: 'C says Z', at: 2500 }, SEATS);
  assert.equal(table.entries.filter(entry => entry.speaker !== 'chair').length, 0, 'staged answers are not entries yet');
  let effects2;
  [table, effects2] = tableReduce(table, { type: 'answer', seat: 1, text: 'B says Y', at: 3000 }, SEATS);
  assert.deepEqual(table.entries.filter(entry => entry.round === 1 && entry.speaker !== 'chair').map(entry => entry.speaker), [0, 1, 2], 'released in seat order');
  assert.equal(table.round, 2);
  assert.equal(table.phase, 'floor');
  assert.equal(table.floor, 0);
  const floorSend = sends(effects2)[0];
  assert.equal(floorSend.seat, 0);
  assert.match(floorSend.text, /seat 2 · codex · gpt-6 \(round 1\)/);
  assert.match(floorSend.text, /B says Y/);
});

test('floor serializes in seat order, rounds advance, done after maxRounds', () => {
  let [table] = start();
  for (const seat of [0, 1, 2]) [table] = tableReduce(table, { type: 'answer', seat, text: `r1 s${seat}`, at: 2000 }, SEATS);
  // Rounds 2 and 3, three seats each.
  for (let round = 2; round <= 3; round++) {
    for (const seat of [0, 1, 2]) {
      assert.equal(table.floor, seat);
      assert.equal(table.round, round);
      let effects;
      [table, effects] = tableReduce(table, { type: 'answer', seat, text: `r${round} s${seat}`, at: 3000 }, SEATS);
      if (!(round === 3 && seat === 2)) {
        const next = sends(effects)[0];
        // The next floor prompt carries exactly the unseen entries.
        assert.match(next.text, new RegExp(`r${round} s${seat}`));
      }
    }
  }
  assert.equal(table.phase, 'done');
  assert.equal(table.endReason, 'completed');
});

test('an interjection lands immediately and rides the next floor prompt once', () => {
  let [table] = start();
  for (const seat of [0, 1, 2]) [table] = tableReduce(table, { type: 'answer', seat, text: `r1 s${seat}`, at: 2000 }, SEATS);
  [table] = tableReduce(table, { type: 'interject', text: 'CSV only for this version', at: 2500 }, SEATS);
  assert.equal(table.entries.at(-1).speaker, 'chair');
  let effects;
  [table, effects] = tableReduce(table, { type: 'answer', seat: 0, text: 'r2 s0', at: 3000 }, SEATS);
  const next = sends(effects)[0];
  assert.equal(next.seat, 1);
  assert.match(next.text, /── chair ──\nCSV only for this version/);
  // Seat 1 has now seen it; its next prompt (round 3) must not repeat it.
  [table] = tableReduce(table, { type: 'answer', seat: 1, text: 'r2 s1', at: 3100 }, SEATS);
  let effects3;
  [table, effects3] = tableReduce(table, { type: 'answer', seat: 2, text: 'r2 s2', at: 3200 }, SEATS);
  const round3 = sends(effects3)[0];
  assert.equal(round3.seat, 0);
  assert.match(round3.text, /r2 s1/);
});

test('pause holds the next floor grant; resume re-sends; end stops; death advances', () => {
  let [table] = start();
  for (const seat of [0, 1]) [table] = tableReduce(table, { type: 'answer', seat, text: `s${seat}`, at: 2000 }, SEATS);
  [table] = tableReduce(table, { type: 'pause' }, SEATS);
  assert.equal(table.pauseAfterTurn, true);
  [table] = tableReduce(table, { type: 'answer', seat: 2, text: 's2', at: 2500 }, SEATS);
  assert.equal(table.phase, 'paused');
  let effects;
  [table, effects] = tableReduce(table, { type: 'resume', at: 3000 }, SEATS);
  assert.equal(table.phase, 'floor');
  assert.equal(sends(effects)[0].seat, 0);
  // Floor holder dies: table records it and moves to the next seat.
  let deathEffects;
  [table, deathEffects] = tableReduce(table, { type: 'seat-died', seat: 0, at: 3500 }, SEATS);
  assert.ok(table.entries.some(entry => entry.died && entry.speaker === 0));
  assert.equal(sends(deathEffects)[0]?.seat, 1);
  [table] = tableReduce(table, { type: 'end', reason: 'chair', at: 4000 }, SEATS);
  assert.equal(table.phase, 'done');
  assert.deepEqual(table.awaiting, {});
});

test('a timeout stands in for the answer and the table moves on', () => {
  let [table] = start();
  [table] = tableReduce(table, { type: 'answer', seat: 0, text: 's0', at: 2000 }, SEATS);
  [table] = tableReduce(table, { type: 'answer', seat: 1, text: 's1', at: 2000 }, SEATS);
  let effects;
  [table, effects] = tableReduce(table, { type: 'timeout', seat: 2, at: 9000 }, SEATS);
  assert.equal(table.phase, 'floor');
  assert.ok(table.entries.some(entry => entry.timedOut && entry.speaker === 2));
  assert.ok(sends(effects).length);
});

test('prompts carry round numbers and the blind rules', () => {
  const blind = composeBlindPrompt({ topic: 'T', maxRounds: 3, seatIndex: 1, members: [0, 1, 2], seats: SEATS });
  assert.match(blind, /\[Table · round 1 of 3\] Topic: T/);
  assert.match(blind, /seat 2 · codex · gpt-6/);
  assert.match(blind, /blind/);
  assert.match(blind, /already established in this conversation/);
  assert.match(blind, /prior evidence the other seats need/);
  assert.match(blind, /chair decides what to accept/);
  const [table] = start();
  const floor = composeFloorPrompt({ table: { ...table, round: 2 }, seatIndex: 0, seats: SEATS });
  assert.match(floor, /round 2 of 3/);
  assert.match(floor, /You now hold the floor, seat 1/);
});

test('renderTable: staged answers stay hidden, header and markers present', () => {
  let [table] = start();
  [table] = tableReduce(table, { type: 'answer', seat: 0, text: 'SECRET-EARLY', at: 2000 }, SEATS);
  const ui = { input: '', scroll: 0 };
  const colorOf = () => '';
  const held = renderTable({ table, ui, seats: SEATS, width: 110, height: 24, colorOf, now: 5000 });
  const plain = held.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert.doesNotMatch(plain, /SECRET-EARLY/, 'blind answers never render before release');
  assert.match(plain, /held until all finish/);
  assert.match(plain, /◌ unverified/, 'a table awaiting a reply does not establish native working evidence');
  assert.match(plain, /round 1 of 3/);
  for (const seat of [1, 2]) [table] = tableReduce(table, { type: 'answer', seat, text: `answer ${seat}`, at: 2500 }, SEATS);
  const released = renderTable({ table, ui, seats: SEATS, width: 110, height: 30, colorOf, now: 6000 }).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert.match(released, /SECRET-EARLY/);
  assert.match(released, /round 2 of 3/);
});

test('renderTable: the input box grows as typed text wraps, cursor at the end', () => {
  const [table] = start();
  const colorOf = () => '';
  const width = 40, height = 24;
  const long = 'x'.repeat(80) + 'TAIL';
  const render = input => renderTable({ table, ui: { input, scroll: 0 }, seats: SEATS, width, height, colorOf, now: 5000 });
  const short = render('hi');
  const grown = render(long);
  const plainGrown = grown.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[\?25h/g, '');
  assert.match(plainGrown, /› x/);
  assert.match(plainGrown, /TAIL/, 'wrapped tail renders on a continuation row');
  assert.equal(plainGrown.split('│').length - 1, 3, '84 chars at a 34-char wrap is three input rows');
  const cursor = output => output.match(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/).slice(1, 3).map(Number);
  assert.deepEqual(cursor(short), [height - 2, 4 + 'hi'.length + 1]);
  // 84 chars wrap 34/34/16: cursor on the last input row, after the 16th char.
  assert.deepEqual(cursor(grown), [height - 2, 4 + 16 + 1], 'cursor sits at the end of the last input row');
});

test('renderTable: the status line carries the turn limit when one is set', () => {
  const [table] = start();
  const render = waitMinutes => renderTable({ table, ui: { input: '', scroll: 0, waitMinutes }, seats: SEATS, width: 110, height: 24, colorOf: () => '', now: 5000 })
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  assert.match(render(30), /limit 30m/);
  assert.doesNotMatch(render(undefined), /limit \d+m/);
  assert.match(render(15), /Alt\+-\/= turn limit/);
});

test('finalAssistantText reads the last assistant message for both agents', () => {
  const claude = parseRecords([
    JSON.stringify({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Draft' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Final claude answer' }] } }),
  ].join('\n'));
  assert.equal(finalAssistantText(claude, 'claude'), 'Final claude answer');
  const codex = parseRecords([
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Q' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Final codex answer' } }),
  ].join('\n'));
  assert.equal(finalAssistantText(codex, 'codex'), 'Final codex answer');
  assert.equal(finalAssistantText([], 'claude'), null);
});
