import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

function settings(file, parse) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot verify manual permissions: could not read ${file}.`);
  }
  try {
    const config = parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected settings object');
    return config;
  }
  catch { throw new Error(`Cannot verify manual permissions: invalid settings in ${file}.`); }
}

// These CLIs expose an enable-auto flag but no documented per-launch manual
// override. Refuse conflicting defaults instead of mislabelling an auto session.
// Never rewrite the user's provider configuration or copy authentication data.
export function checkManualDefaults(agent, { env = process.env, home = os.homedir() } = {}) {
  if (agent === 'antigravity') {
    const file = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    const config = settings(file, JSON.parse);
    if (!['', 'default', 'plan'].includes(config.agentMode ?? '') || !['request-review', 'strict'].includes(config.toolPermission ?? 'request-review')) {
      throw new Error('Antigravity is configured for automatic actions. Set agentMode to "" and toolPermission to "request-review" in its settings before launching a manual seat.');
    }
  }
  if (agent === 'kimi') {
    const files = [path.join(env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'config.toml'), path.join(home, '.kimi', 'config.toml')];
    for (const file of files) {
      const config = settings(file, parseToml);
      if ((config.default_permission_mode ?? 'manual') !== 'manual') {
        throw new Error(`Kimi is configured for automatic actions. Set default_permission_mode to "manual" in ${file} before launching a manual seat.`);
      }
    }
  }
}

export function seatPermissionEnvironment(seat, env) {
  if (seat.agent !== 'opencode' || seat.bypass === true) return env;
  return { ...env, OPENCODE_PERMISSION: JSON.stringify({ '*': 'ask' }) };
}
