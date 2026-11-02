import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { elapsedLabel, consoleLayout, seatCard, paintShelf, shelfSeatAt, inner, orderSelection, paintComposer, paintContent, renderLine, selectionRange, selectionText } from '../station-view.mjs';
import { createShelfDrag } from '../station-view.mjs';
import { shelfActionAt } from '../station-view.mjs';

const { Terminal } = headless;
const plain = text => text.replace(/\x1b\[[0-9;]*[mH]/g, '');
const tracked = (activity, extra = {}) => ({ lifecycle: 'running', activity, source: 'native', watcher: { state: 'healthy' }, completionVersion: 1, readVersion: 1, turnStartedAt: 1000, ...extra });
test('card action hits route inspect and read while other clicks only focus',()=>{
 const region=consoleLayout(120,36).shelf;
 const seats=[{attention:tracked('idle',{watcher:{state:'error'}})},{attention:tracked('completed',{readVersion:0})}];
 assert.deepEqual(shelfActionAt(region,seats,0,3,5),{index:0,key:'\x1bs'});
 assert.deepEqual(shelfActionAt(region,seats,1,3,11),{index:1,key:'\x1bt'});
 assert.deepEqual(shelfActionAt(region,seats,0,3,11),{index:1,key:null});
 assert.deepEqual(shelfActionAt(region,seats,0,3,2),{index:0,key:null});
});

test('Console geometry stays fixed across seat counts; short shelves page around focus', () => {
  const layout = consoleLayout(120, 36);
  assert.deepEqual(layout.shelf, { x: 0, y: 0, width: 26, height: 35 });
  assert.deepEqual(layout.surface, { x: 26, y: 0, width: 94, height: 35 });
  assert.deepEqual(inner(layout.surface), layout.surface);
  assert.equal(shelfSeatAt(layout.shelf, 4, 0, 3, 8), 1);
  assert.equal(shelfSeatAt(layout.shelf, 4, 0, 27, 8), -1);
  assert.equal(shelfSeatAt(consoleLayout(80, 16).shelf, 4, 3, 3, 2), 2);
});

test('divider drag clamps width, ignores content drags, and retains preference across window resize', () => {
  const drag = createShelfDrag();
  assert.equal(drag({kind:'press',x:35,y:5},120,36),false);
  assert.equal(drag({kind:'drag',x:50,y:5},120,36),false);
  assert.equal(drag({kind:'press',x:26,y:2},120,36),true);
  assert.equal(drag({kind:'drag',x:50,y:2},120,36),true);
  assert.equal(drag({kind:'release',x:50,y:2},120,36),true);
  assert.equal(consoleLayout(120,36).shelf.width,50);
  assert.equal(consoleLayout(80,24).surface.width,40);
  assert.equal(consoleLayout(120,36).shelf.width,50);
  assert.equal(consoleLayout(120,36,500).surface.width,40);
  assert.equal(consoleLayout(80,24,1).shelf.width,26);
  drag({kind:'press',x:50,y:2},120,36);
  drag({kind:'release',x:26,y:2},120,36);
});

test('shortened card labels are explicit and widen to the full text', () => {
  const seat = {seat:'codex',model:'gpt-6.1-sol',effort:'medium',attention:tracked('working')};
  assert.ok(plain(seatCard(seat,1)[0]).endsWith('…'));
  assert.match(plain(seatCard(seat,1,{width:48})[0]),/gpt-6.1-sol · medium/);
});

test('five-line cards preserve posture, native vocabulary and honest read actions', () => {
  const seat = { seat: 'claude', model: 'opus', effort: 'high', nativeId: 'a', attention: tracked('working') };
  const card = seatCard(seat, 0, { now: 71000 });
  assert.equal(card.length, 5); assert.equal(plain(card[4]), '');
  assert.match(plain(card[0]), /1 claude · opus · high/);
  assert.match(plain(card[1]), /◐ working 1:10/);
  assert.match(plain(card[1]), /·/);
  assert.match(plain(card[3]), /Alt\+1 terminal/);
  const bypass = seatCard({ ...seat, bypass: true }, 0);
  assert.match(bypass[0], /\x1b\[7mBYPASS/);
  assert.match(plain(seatCard(seat, 0, { readToken: { nativeId: 'a', version: 7 } })[3]), /m read v7/);
  assert.equal(plain(seatCard(seat, 2, { focused: false })[3]), 'Alt+3 focus');
  assert.equal(plain(seatCard(seat, 2, { focused: false, reading: true })[3]), 'Tab switches seats');
  assert.equal(plain(seatCard(seat, 0, { reading: true })[3]), 'Esc back');
  assert.equal(elapsedLabel(62), '1:02');
});

test('a buffer row renders styled, padded and clipped to its column', async () => {
  const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  await new Promise(resolve => terminal.write('\x1b[1;31mred\x1b[0m plain', resolve));
  const line = terminal.buffer.active.getLine(0);
  assert.equal(plain(renderLine(line, 12)), 'red plain   ');
  assert.match(renderLine(line, 12), /38;5;1|38;2;/);
  assert.equal(plain(renderLine(line, 5)), 'red p');
});

test('content paints into the inner region with absolute moves', async () => {
  const terminal = new Terminal({ cols: 10, rows: 3, allowProposedApi: true });
  await new Promise(resolve => terminal.write('one\r\ntwo', resolve));
  const painted = paintContent(terminal, { x: 40, y: 5, width: 12, height: 5 });
  assert.match(painted, /\x1b\[6;41H/);
  assert.match(plain(painted), /one/);
});

test('a selection is ordered, ranged per row, and painted inverse', async () => {
  const backwards = { anchorRow: 5, anchorCol: 3, headRow: 4, headCol: 7 };
  assert.deepEqual(orderSelection(backwards), { startRow: 4, startCol: 7, endRow: 5, endCol: 3 });
  const sel = { anchorRow: 4, anchorCol: 7, headRow: 5, headCol: 3 };
  assert.deepEqual(selectionRange(sel, 4, 20), { from: 7, to: 19 });
  assert.deepEqual(selectionRange(sel, 5, 20), { from: 0, to: 3 });
  assert.equal(selectionRange(sel, 6, 20), null);
  const terminal = new Terminal({ cols: 20, rows: 3, allowProposedApi: true });
  await new Promise(resolve => terminal.write('selectable', resolve));
  const line = terminal.buffer.active.getLine(0);
  assert.match(renderLine(line, 12, { from: 2, to: 5 }), /7m/);
});

test('copied text crosses rows with newlines but joins soft-wrapped lines', async () => {
  const terminal = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
  // 'wrapping continues' soft-wraps across two buffer rows; 'next' is a hard
  // new line.
  await new Promise(resolve => terminal.write('wrapping continues\r\nnext', resolve));
  const text = selectionText(terminal, { anchorRow: 0, anchorCol: 0, headRow: 2, headCol: 3 });
  assert.equal(text, 'wrapping continues\nnext');
  const partial = selectionText(terminal, { anchorRow: 0, anchorCol: 2, headRow: 0, headCol: 6 });
  assert.equal(partial, 'appin');
});

test('the composer cursor sits on the typed text, never the border below it', () => {
  const wrap = (text, width) => text.split('\n').flatMap(raw => raw.match(new RegExp(`.{1,${width}}`, 'g')) || ['']);
  const seats = [{ seat: 'claude' }, { seat: 'codex' }];
  const one = paintComposer({ width: 100, usableRows: 13, seats, targets: [0], text: 'hello', colorOf: () => '', wrap });
  // Rows 0-based: 9 top border, 10 chips, 11 the text row, 12 bottom border.
  assert.equal(one.cursor.row, 11);
  assert.equal(one.cursor.column, 4 + 'hello'.length);
  const two = paintComposer({ width: 100, usableRows: 13, seats, targets: [0], text: 'a\nbc', colorOf: () => '', wrap });
  assert.equal(two.cursor.row, 11);
  assert.equal(two.cursor.column, 4 + 'bc'.length);
});

test('the shelf shows all seats without spilling into the work surface', async () => {
  for (const width of [80, 120, 160]) {
    const terminal = new Terminal({ cols: width, rows: 36, allowProposedApi: true });
    const seats = [{ seat: 'claude', bypass: true, attention: tracked('working') }, { seat: 'codex', attention: tracked('waiting', { waitReason: 'prompt', promptKind: 'approval', source: 'screen' }) }];
    await new Promise(resolve => terminal.write(paintShelf(consoleLayout(width, 36).shelf, seats, 0), resolve));
    const rows = Array.from({ length: 36 }, (_, i) => terminal.buffer.active.getLine(i).translateToString(true));
    assert.match(rows.join('\n'), /BYPASS/); assert.match(rows.join('\n'), /blocked/);
    assert.ok(rows.every(row => row.length <= 26)); terminal.dispose();
  }
});
