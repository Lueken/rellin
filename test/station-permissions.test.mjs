import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AGENTS, terminalCommand } from '../agents.mjs';
import { stationSeats } from '../station.mjs';
import { checkManualDefaults, seatPermissionEnvironment } from '../station-permissions.mjs';
import { defaultSetup, presetSeats, setupApply } from '../station-setup.mjs';

test('all agents start manual through defaults, add and reused lineup; auto requires an explicit choice', () => {
  for (const { id } of AGENTS.filter(agent => agent.id !== 'shell')) {
    const options = { available: [id], last: [{ agent: id, mode: 'auto' }] };
    assert.equal(stationSeats(id)[0].bypass, false);
    assert.equal(stationSeats(`${id}:default:default:default`)[0].mode, 'manual');
    assert.equal(stationSeats(`${id}:default:default:auto`)[0].bypass, true);
    const state = defaultSetup([id]);
    assert.ok(state.seats.every(seat => seat.mode === 'manual'));
    assert.equal(setupApply(state, { type: 'add' }, options).seats.at(-1).mode, 'manual');
    for (const preset of ['solo', 'duo', 'quad', 'review', 'last']) assert.ok(presetSeats(preset, options).every(seat => seat.mode === 'manual'));
  }
});

test('manual launch arguments explicitly select approvals and never enable bypass, including resume', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'station-permissions-'));
  const before = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME };
  for (const agent of AGENTS.filter(agent => agent.id !== 'shell')) await writeFile(path.join(root, agent.command + (process.platform === 'win32' ? '.exe' : '')), '', { mode: 0o755 });
  Object.assign(process.env, { PATH: root, HOME: root, USERPROFILE: root, KIMI_CODE_HOME: root });
  const bypassFlags = ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions', '--always-approve', '--yolo', '--auto'];
  try {
    for (const agent of AGENTS.filter(agent => agent.id !== 'shell')) {
      const args = terminalCommand(agent.id, {}).args;
      assert.ok(!args.some(arg => bypassFlags.includes(arg)), agent.id);
      assert.ok(terminalCommand(agent.id, { bypass: true }).args.some(arg => bypassFlags.includes(arg)), agent.id);
    }
    for (const resumeId of [undefined, '11111111-1111-4111-8111-111111111111']) {
      const claude = terminalCommand('claude', { model: 'opus', effort: 'high', resumeId }).args;
      assert.equal(claude[claude.indexOf('--permission-mode') + 1], 'manual');
      assert.equal(claude[claude.indexOf('--model') + 1], 'opus');
      assert.equal(claude[claude.indexOf('--effort') + 1], 'high');
      const codex = terminalCommand('codex', { resumeId }).args;
      assert.equal(codex[codex.indexOf('--ask-for-approval') + 1], 'on-request');
      assert.equal(codex[codex.indexOf('--sandbox') + 1], 'workspace-write');
      assert.ok(codex.includes('approvals_reviewer="user"'));
      const grok = terminalCommand('grok', { resumeId }).args;
      assert.equal(grok[grok.indexOf('--permission-mode') + 1], 'default');
    }
    assert.ok(terminalCommand('opencode', {}).args.includes('--auto=false'));
    assert.ok(!terminalCommand('claude', { bypass: 'false' }).args.includes('--dangerously-skip-permissions'));
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('manual OpenCode replaces inherited blanket allow for this child only', () => {
  const env = { PATH: 'bin', OPENCODE_PERMISSION: '{"*":"allow"}' };
  const manual = seatPermissionEnvironment({ agent: 'opencode', bypass: false }, env);
  assert.equal(JSON.parse(manual.OPENCODE_PERMISSION)['*'], 'ask');
  assert.equal(JSON.parse(env.OPENCODE_PERMISSION)['*'], 'allow');
  assert.equal(seatPermissionEnvironment({ agent: 'opencode', bypass: true }, env), env);
});

test('providers without a manual launch override reject conflicting defaults instead of silently starting auto', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-mode-guards-'));
  const agy = path.join(home, '.gemini', 'antigravity-cli'), kimi = path.join(home, 'custom-kimi');
  await mkdir(agy, { recursive: true }); await mkdir(kimi);
  const options = { home, env: { KIMI_CODE_HOME: kimi } };
  checkManualDefaults('antigravity', options); checkManualDefaults('kimi', options);
  await writeFile(path.join(agy, 'settings.json'), JSON.stringify({ toolPermission: 'always-proceed' }));
  assert.throws(() => checkManualDefaults('antigravity', options), /automatic actions/);
  await writeFile(path.join(agy, 'settings.json'), JSON.stringify({ agentMode: 'auto', toolPermission: 'request-review' }));
  assert.throws(() => checkManualDefaults('antigravity', options), /automatic actions/);
  await writeFile(path.join(agy, 'settings.json'), JSON.stringify({ agentMode: '', toolPermission: 'request-review' }));
  checkManualDefaults('antigravity', options);
  await writeFile(path.join(agy, 'settings.json'), JSON.stringify({ agentMode: 'plan', toolPermission: 'strict' }));
  checkManualDefaults('antigravity', options);
  await writeFile(path.join(agy, 'settings.json'), 'null');
  assert.throws(() => checkManualDefaults('antigravity', options), /invalid settings/);
  await writeFile(path.join(kimi, 'config.toml'), 'default_permission_mode = "yolo"');
  assert.throws(() => checkManualDefaults('kimi', options), /default_permission_mode/);
  await writeFile(path.join(kimi, 'config.toml'), 'default_permission_mode = "manual"');
  checkManualDefaults('kimi', options);
  await writeFile(path.join(kimi, 'config.toml'), 'invalid = [');
  assert.throws(() => checkManualDefaults('kimi', options), /invalid settings/);
});
