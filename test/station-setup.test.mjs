import test from 'node:test';
import assert from 'node:assert/strict';
import { actionAt, defaultSetup, discoverOptions, fieldOptions, parseClaudeHelp, parseCodexCatalog, parseCodexConfig, parseSgrClicks, presetSeats, setupApply, setupRender } from '../station-setup.mjs';

const OPTIONS = { available: ['claude', 'codex'] };

test('claude help text yields its own effort and model vocabulary', () => {
  const help = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').`;
  const parsed = parseClaudeHelp(help);
  assert.deepEqual(parsed.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(parsed.models, ['fable', 'opus', 'sonnet']);
});

test('the codex catalog yields listed slugs in priority order with per-model efforts', () => {
  const catalog = JSON.stringify({ models: [
    { slug: 'gpt-6-astra', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'xhigh' }] },
    { slug: 'gpt-6.1-sol', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
    { slug: 'gpt-hidden', visibility: 'hidden', priority: 0, supported_reasoning_levels: [{ effort: 'low' }] },
  ] });
  const parsed = parseCodexCatalog(catalog);
  assert.deepEqual(parsed.models, ['gpt-6.1-sol', 'gpt-6-astra']);
  assert.deepEqual(parsed.efforts['gpt-6.1-sol'], ['low', 'ultra']);
  assert.deepEqual(parsed.efforts.default.sort(), ['low', 'medium', 'ultra', 'xhigh']);
  assert.deepEqual(parseCodexConfig('model = "gpt-6-luna"\n[profiles.deep]\nmodel = "gpt-6-astra"').models, ['gpt-6-luna', 'gpt-6-astra']);
});

test('effort options follow the seat\'s chosen model when the table is per-model', () => {
  const options = { available: ['codex'], efforts: { codex: { 'gpt-6-astra': ['high', 'xhigh'], default: ['medium'] } } };
  assert.deepEqual(fieldOptions('effort', { agent: 'codex', model: 'gpt-6-astra' }, options), ['default', 'high', 'xhigh']);
  assert.deepEqual(fieldOptions('effort', { agent: 'codex', model: 'default' }, options), ['default', 'medium']);
  assert.deepEqual(fieldOptions('mode', { agent: 'codex' }, options), ['manual', 'auto']);
});

test('the grok catalog yields model ids with per-model efforts', async () => {
  const { parseGrokCatalog } = await import('../station-setup.mjs');
  const parsed = parseGrokCatalog(JSON.stringify({ models: {
    'grok-4.7': { info: { id: 'grok-4.7', reasoning_efforts: [{ id: 'xhigh' }, { id: 'high' }] } },
    'grok-4.5': { info: { id: 'grok-4.5', reasoning_efforts: [{ id: 'low' }] } },
  } }));
  assert.deepEqual(parsed.models, ['grok-4.7', 'grok-4.5']);
  assert.deepEqual(parsed.efforts['grok-4.7'], ['xhigh', 'high']);
  assert.deepEqual(parsed.efforts.default.sort(), ['high', 'low', 'xhigh']);
});

test('discovery merges providers over the floor and never throws', async () => {
  const discovered = await discoverOptions(process.env);
  assert.ok(discovered.models.claude.includes('fable'));
  assert.ok(discovered.efforts.claude.includes('xhigh'));
  assert.ok(discovered.models.codex.includes('gpt-6-astra'));
  const codexEfforts = fieldOptions('effort', { agent: 'codex', model: 'default' }, { available: [], ...discovered });
  assert.ok(codexEfforts.includes('xhigh'));
});

test('presets fill the table: duo, quad, review panel, and the last configuration', () => {
  assert.equal(presetSeats('solo', OPTIONS).length, 1);
  assert.equal(presetSeats('last', { ...OPTIONS, last: [{ agent: 'claude' }] }).length, 1);
  assert.deepEqual(presetSeats('duo', OPTIONS).map(seat => seat.agent), ['claude', 'codex']);
  assert.equal(presetSeats('quad', OPTIONS).length, 4);
  assert.deepEqual(presetSeats('review', OPTIONS).map(seat => seat.agent), ['claude', 'codex', 'claude']);
  const last = [{ agent: 'codex', model: 'gpt-6-astra', effort: 'xhigh', mode: 'auto' }, { agent: 'claude' }];
  const restored = presetSeats('last', { ...OPTIONS, last });
  assert.equal(restored[0].model, 'gpt-6-astra');
  assert.equal(restored[0].mode, 'manual', 'a new run never inherits last table auto mode');
  assert.equal(restored[1].effort, 'default');
  assert.equal(presetSeats('last', OPTIONS), null);
});

test('keyboard drives the list: move, cycle, add, remove', () => {
  let state = defaultSetup(OPTIONS.available);
  state = setupApply(state, { type: 'move', seats: 1 }, OPTIONS);
  assert.equal(state.cursor.seat, 1);
  state = setupApply(state, { type: 'move', fields: 1 }, OPTIONS);
  assert.equal(state.cursor.field, 1);
  state = setupApply(state, { type: 'cycle', delta: 1 }, OPTIONS);
  assert.notEqual(state.seats[1].model, 'default');
  state = setupApply(state, { type: 'cycle', delta: -1 }, OPTIONS);
  assert.equal(state.seats[1].model, 'default');
  state = setupApply(state, { type: 'add' }, OPTIONS);
  assert.equal(state.seats.length, 3);
  assert.equal(state.cursor.seat, 2);
  state = setupApply(state, { type: 'remove', seat: 2 }, OPTIONS);
  assert.equal(state.seats.length, 2);
  state = setupApply(state, { type: 'remove', seat: 1 }, OPTIONS);
  assert.equal(state.seats.length, 1);
  assert.equal(setupApply(state, { type: 'remove', seat: 0 }, OPTIONS).seats.length, 1);
});

test('clicks route through rendered regions, and the picker overlay wins on top', () => {
  let state = defaultSetup(OPTIONS.available);
  let { regions } = setupRender(state, OPTIONS);
  const open = regions.find(region => region.action.type === 'open' && region.action.field === 1);
  state = setupApply(state, actionAt(regions, open.x1, open.row), OPTIONS);
  assert.deepEqual(state.dropdown, { seat: 0, field: 'model' });
  ({ regions } = setupRender(state, OPTIONS));
  const pick = regions.find(region => region.action.type === 'pick' && region.action.value === 'fable');
  assert.ok(pick, 'the overlay offers fable');
  // The overlay covers seat 2's row; the click must hit the overlay option,
  // not the field underneath.
  assert.deepEqual(actionAt(regions, pick.x1 + 1, pick.row).type, 'pick');
  state = setupApply(state, actionAt(regions, pick.x1 + 1, pick.row), OPTIONS);
  assert.equal(state.seats[0].model, 'fable');
  assert.equal(state.dropdown, null);
  ({ regions } = setupRender(state, OPTIONS));
  const preset = regions.find(region => region.action.type === 'preset' && region.action.name === 'quad');
  state = setupApply(state, actionAt(regions, preset.x1, preset.row), OPTIONS);
  assert.equal(state.seats.length, 4);
  assert.equal(setupApply(state, { type: 'start' }, OPTIONS).done, true);
});

test('changing an agent resets model, effort and permission mode', () => {
  let state = defaultSetup(OPTIONS.available);
  state = setupApply(state, { type: 'pick', seat: 0, field: 'mode', value: 'auto' }, OPTIONS);
  state = setupApply(state, { type: 'pick', seat: 0, field: 'model', value: 'fable' }, OPTIONS);
  state = setupApply(state, { type: 'pick', seat: 0, field: 'agent', value: 'codex' }, OPTIONS);
  assert.deepEqual(state.seats[0], { agent: 'codex', model: 'default', effort: 'default', mode: 'manual' });
});

test('only left-button SGR presses count as clicks', () => {
  assert.deepEqual(parseSgrClicks('\x1b[<0;12;5M'), [{ x: 12, y: 5 }]);
  assert.deepEqual(parseSgrClicks('\x1b[<0;12;5m'), []);
  assert.deepEqual(parseSgrClicks('\x1b[<32;9;9M\x1b[<2;4;4M\x1b[<0;1;2M'), [{ x: 1, y: 2 }]);
});

test('colour never moves a visible character', async () => {
  const { colorizeSetup } = await import('../station-setup.mjs');
  const state = { ...defaultSetup(OPTIONS.available), dropdown: { seat: 0, field: 'model' } };
  const { lines } = setupRender(state, { ...OPTIONS, cwd: '~/repo' });
  const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
  lines.forEach((line, index) => {
    assert.equal(plain(colorizeSetup(line, index, state, () => '\x1b[31m')), line, `line ${index} unchanged`);
  });
  const live = setupRender(defaultSetup(OPTIONS.available), OPTIONS);
  const identity = live.lines.findIndex(line => /^›1 /.test(line));
  assert.ok(identity >= 0);
  const styled = colorizeSetup(live.lines[identity], identity, defaultSetup(OPTIONS.available), () => '\x1b[31m');
  assert.match(styled,/\x1b\[31m\x1b\[1m1 /);
});

test('every rendered region points at text that is actually there', () => {
  for (const dropdown of [null, { seat: 0, field: 'effort' }]) {
    const state = { ...defaultSetup(OPTIONS.available), dropdown };
    const { lines, regions } = setupRender(state, OPTIONS);
    for (const region of regions) {
      const line = lines[region.row - 1];
      assert.ok(line && line.length >= region.x2, `region ${JSON.stringify(region.action)} fits its line`);
    }
  }
});

test('preset buttons, add and start have matching visible click targets at both shelf widths', () => {
  for (const width of [80,120]) for (const shelfWidth of [26,40]) {
    const state=defaultSetup(OPTIONS.available);
    const {lines,regions}=setupRender(state,{...OPTIONS,width,height:30,shelfWidth,last:state.seats});
    const presets=regions.filter(region=>region.action.type==='preset');
    assert.equal(presets.length,5);
    if(shelfWidth<40) assert.equal(new Set(presets.map(region=>region.row)).size,5,'narrow presets stack, never wrap');
    assert.ok([1,5].includes(new Set(presets.map(region=>region.row)).size),'presets use one horizontal row or one button per row');
    const continuation=regions.find(region=>region.action.type==='continue');
    assert.ok(continuation.row < Math.min(...presets.map(region=>region.row)));
    assert.match(lines[continuation.row-1],/\[ Continue session \]/);
    for(const region of presets) {
      assert.match(lines[region.row-1].slice(region.x1-1,region.x2),/^\[ .+ \]$/);
      assert.equal(actionAt(regions,region.x1,region.row).type,'preset');
    }
    assert.ok(regions.some(region=>region.action.type==='start'));
    assert.ok(lines.some(line=>line.includes('Click a field')));
    assert.ok(lines.some(line=>line.includes('[ + Add agent ]')));
  }
});
