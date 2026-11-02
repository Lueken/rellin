import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { observeNativeInput, observeNativeScreen, nativeComposer } from '../station-native-input.mjs';
import { readinessProblem, guardedDelivery } from '../station-coordination.mjs';

const ready = () => ({ agent: 'claude', alive: true, watcher: {}, attention: { lifecycle: 'running', source: 'native', activity: 'completed', completionVersion: 1, watcher: { state: 'healthy' } } });
const composer = (text = '') => `\x1b[2J\x1b[HClaude Code\r\n────────────────────────────\r\n❯ ${text}\r\n────────────────────────────\x1b[3;${3 + text.length}H`;
const paint = async (seat, term, text) => {
  await new Promise(resolve => term.write(text, resolve));
  seat.nativeScreenVersion = (seat.nativeScreenVersion || 0) + 1;
  observeNativeScreen(seat, term);
};

test('Claude /usage is a local menu; Escape needs a returned composer before releasing its gate', async () => {
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  try {
  const seat = { agent: 'claude', alive: true, watcher: {}, attention: { lifecycle: 'running', source: 'native', activity: 'completed', completionVersion: 1, watcher: { state: 'healthy' } } };
  for (const c of '/usage') observeNativeInput(seat, c);
  assert.deepEqual(observeNativeInput(seat, '\r'), { submitted: true, expectTurn: false });
  assert.match(readinessProblem(seat), /close \/usage/);
  assert.equal(observeNativeInput(seat, '\r').expectTurn, false, 'Enter inside menu is not a new turn');
  observeNativeInput(seat, '\x1b');
  assert.match(readinessProblem(seat), /close \/usage/, 'Esc alone does not prove the menu closed');
  await paint(seat, term, composer());
  assert.equal(readinessProblem(seat), null);
  observeNativeInput(seat, 'normal question');
  assert.equal(observeNativeInput(seat, '\r').expectTurn, true);
  } finally { term.dispose(); }
});

test('documented bare Claude dialogs gate typed and pasted commands, without changing native attention', () => {
  for (const command of ['/usage', '/status', '/model', '/config', '/settings', '/permissions', '/mcp', '/help', '/theme']) {
    for (const data of [command, `\x1b[200~${command}\x1b[201~`]) {
      const seat = ready(), attention = structuredClone(seat.attention);
      observeNativeInput(seat, data);
      assert.equal(observeNativeInput(seat, '\r').expectTurn, false);
      assert.equal(seat.localCommand, command);
      assert.match(readinessProblem(seat), /close/);
      assert.deepEqual(seat.attention, attention);
    }
  }
  for (const command of ['/model opus', '/config theme=dark', '/review', '/compact', 'Explain /model', '/model\nordinary question']) {
    const seat = ready(); observeNativeInput(seat, `\x1b[200~${command}\x1b[201~`); observeNativeInput(seat, '\r');
    assert.equal(seat.localCommand, undefined, command);
  }
  const codex = { ...ready(), agent: 'codex' };
  observeNativeInput(codex, '/config'); observeNativeInput(codex, '\r');
  assert.equal(codex.localCommand, undefined, 'command meanings are provider-specific');
});

test('history and cursor-edited commands use the actual live composer, not transcript mentions or menu rows', async () => {
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  try {
    for (const key of ['\x1b[A', '\x1b[D', '\t']) {
      const seat = ready(); observeNativeInput(seat, key);
      await paint(seat, term, composer('/config'));
      assert.equal(observeNativeInput(seat, '\r', { terminal: term }).expectTurn, false);
      assert.equal(seat.localCommand, '/config');
    }
    for (const screen of [
      '\x1b[2J\x1b[H❯ /config\r\nOld transcript mention\r\n',
      '\x1b[2J\x1b[HChoose a command\r\n> /config',
      composer('/config extra'),
      composer('/config') + '\x1b[3;4H', // mid-draft cursor: suffix is not guessed away
    ]) {
      const seat = ready(); observeNativeInput(seat, '\x1b[A');
      await paint(seat, term, screen); observeNativeInput(seat, '\r', { terminal: term });
      assert.equal(seat.localCommand, undefined);
    }
    await paint(ready(), term, composer('/theme'));
    term.scrollToTop();
    assert.equal(nativeComposer('claude', term), '/theme');
  } finally { term.dispose(); }
});

test('nested menus and stale screens keep delivery blocked; selecting back to input releases without consuming unread', async () => {
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true }), seat = ready();
  const writes = [];
  const deliver = () => guardedDelivery({ seat, proc: { write: data => writes.push(data) }, current: () => true, prompt: () => null, refresh: async () => {}, wait: async () => {}, text: 'table request', onSubmit: () => {} });
  try {
    await paint(seat, term, composer());
    observeNativeInput(seat, '/model'); observeNativeInput(seat, '\r');
    seat.nativeOutputVersion = seat.nativeScreenVersion + 1; // received before Esc, still queued for parsing
    observeNativeInput(seat, '\x1b'); observeNativeScreen(seat, term);
    await assert.rejects(deliver(), /close \/model/);
    await paint(seat, term, composer());
    await assert.rejects(deliver(), /close \/model/, 'parsing pre-Esc output cannot release the gate');
    delete seat.nativeOutputVersion;
    await paint(seat, term, '\x1b[2J\x1b[HSelect model\r\n> 1. Default\r\n  2. Sonnet\r\nEsc to close');
    await assert.rejects(deliver(), /close \/model/);
    observeNativeInput(seat, '\r', { prompt: true });
    await paint(seat, term, '\x1b[2J\x1b[HSelect effort\r\n> 1. High\r\n  2. Medium\r\nEsc to go back');
    await assert.rejects(deliver(), /close \/model/);
    assert.deepEqual(writes, [], 'neither paste nor Enter reaches a submenu');
    observeNativeInput(seat, '\r', { prompt: true }); await paint(seat, term, composer());
    assert.equal(seat.attention.completionVersion, 1);
    assert.equal(readinessProblem(seat), null);
    await deliver(); assert.deepEqual(writes, ['\x1b[200~table request\x1b[201~', '\r']);
  } finally { term.dispose(); }
});

test('closing a dialog preserves a restored draft and accepts the known empty-input placeholder', async () => {
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true }), seat = ready();
  try {
    observeNativeInput(seat, '/help'); observeNativeInput(seat, '\r'); observeNativeInput(seat, '\x1b');
    await paint(seat, term, composer('unfinished question'));
    assert.equal(seat.localCommand, null);
    assert.match(readinessProblem(seat), /draft/);
    assert.equal(seat.inputDraft, 'unfinished question');
    const empty = ready(); observeNativeInput(empty, '/theme'); observeNativeInput(empty, '\r'); observeNativeInput(empty, '\x1b');
    await paint(empty, term, composer('Try "fix the tests"') + '\x1b[3;3H');
    assert.equal(empty.localCommand, null);
    assert.equal(empty.inputDraft, '');
    assert.equal(empty.draftDirty, false);
  } finally { term.dispose(); }
});

test('known pasted local commands, blank Enter and approval responses do not arm progress watchdog', () => {
  const seat = { agent: 'claude' };
  observeNativeInput(seat, '\x1b[200~/usage\x1b[201~');
  assert.equal(observeNativeInput(seat, '\r').expectTurn, false);
  observeNativeInput(seat, '\x1b');
  assert.equal(observeNativeInput(seat, '\r').expectTurn, false);
  assert.equal(observeNativeInput(seat, '\r', { prompt: true }).expectTurn, false);
  observeNativeInput(seat, '2');
  assert.equal(observeNativeInput(seat, '\r', { prompt: true }).expectTurn, false);
});

test('unknown cursor edits and slash commands await native evidence without guessing submission', () => {
  const seat = { agent: 'claude' };
  observeNativeInput(seat, '/usage'); observeNativeInput(seat, '\x1b[D');
  assert.equal(observeNativeInput(seat, '\r').expectTurn, false);
  assert.equal(seat.localCommand, undefined);
  observeNativeInput(seat, '/review');
  assert.equal(observeNativeInput(seat, '\r').expectTurn, false);
  assert.equal(seat.localCommand, undefined, 'not every slash command is a known local menu');
});
