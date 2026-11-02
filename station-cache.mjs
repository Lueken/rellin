// Cache observations are separate from attention. Neither silence nor a timer
// proves a cache hit, a completed turn, or remaining subscription allowance.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export const CACHE_PROFILES = Object.freeze({
  claude: { supported: true, writeTiers: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 3600 } },
  codex: { supported: true, writeTiers: {} },
});

export function resolveBilling(agent, env = {}, { home = os.homedir(), platform = process.platform, read = file => JSON.parse(readFileSync(file, 'utf8')) } = {}) {
  const unknown = { mode: 'unknown', label: 'billing unknown' };
  // Gateways can choose authentication independently of local login metadata.
  const overrides = agent === 'claude' ? ['ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'] : ['OPENAI_BASE_URL'];
  if (overrides.some(key => env[key] && env[key] !== '0')) return unknown;
  if (agent === 'claude' && env.ANTHROPIC_AUTH_TOKEN) return unknown;
  const keys = { claude: ['ANTHROPIC_API_KEY'], codex: ['OPENAI_API_KEY','CODEX_API_KEY'], grok: ['XAI_API_KEY'] }[agent] || [];
  if (keys.some(key => typeof env[key] === 'string' && env[key].trim())) return { mode: 'api', label: 'API' };
  try {
    if (agent === 'claude' && platform !== 'darwin') {
      const auth = read(path.join(env.CLAUDE_CONFIG_DIR || path.join(home,'.claude'),'.credentials.json'))?.claudeAiOauth;
      if (['max','pro','team','enterprise'].includes(auth?.subscriptionType)) {
        const tier = /^default_claude_max_(5|20)x$/.exec(auth.rateLimitTier || '');
        return { mode: 'subscription', label: tier ? `max ${tier[1]}x` : auth.subscriptionType };
      }
    }
    if (agent === 'codex' && read(path.join(env.CODEX_HOME || path.join(home,'.codex'),'auth.json'))?.auth_mode === 'chatgpt') return { mode: 'subscription', label: 'ChatGPT plan' };
    if (agent === 'grok' && read(path.join(env.GROK_HOME || path.join(home,'.grok'),'auth.json'))?.auth_mode === 'oidc') return { mode: 'subscription', label: 'Grok plan' };
  } catch { /* Unknown is normal. Never log credentials or read Keychain. */ }
  return unknown;
}

export function cacheObservation(record, agent, requestAt = null) {
  if (record?.isSidechain || record?.isMeta) return null;
  let usage, read, written, scope, tiers = [];
  if (agent === 'claude' && record?.type === 'assistant') {
    usage = record.message?.usage;
    if (!usage) return null;
    read = count(usage.cache_read_input_tokens); written = count(usage.cache_creation_input_tokens); scope = 'request';
    const split = usage.cache_creation;
    if (split && Object.keys(CACHE_PROFILES.claude.writeTiers).every(key => count(split[key]) !== null)
      && split.ephemeral_5m_input_tokens + split.ephemeral_1h_input_tokens === written) {
      tiers = Object.entries(CACHE_PROFILES.claude.writeTiers).filter(([key]) => split[key] > 0).map(([,seconds]) => seconds);
    }
  } else if (agent === 'codex' && record?.type === 'event_msg' && record.payload?.type === 'token_count') {
    const info = record.payload.info;
    usage = info?.last_token_usage || info?.total_token_usage;
    if (!usage) return null;
    read = count(usage.cached_input_tokens); written = null;
    scope = info.last_token_usage ? 'request' : 'session';
  } else return null;
  if (read === null && written === null) return null;
  const at = stamp(record.timestamp);
  // Anchor estimates at request start, never at the later response timestamp.
  // A read count does not identify which TTL was read. Only timed writes get a window.
  const ttl = tiers.length ? Math.min(...tiers) : null;
  const anchor = at !== null && Number.isFinite(requestAt) && requestAt <= at ? requestAt : null;
  return { key: record.message?.id || record.uuid || `${at}:${read}:${written}`, at, read, written, scope,
    model: typeof record.message?.model === 'string' ? record.message.model : null,
    ttlSeconds: ttl, windowEndsAt: ttl && anchor !== null ? anchor + ttl * 1000 : null };
}

export function cacheObserver(agent, emit) {
  let requestAt = null;
  return record => {
    if (record?.isSidechain || record?.isMeta) return;
    if (record?.type === 'user') requestAt = stamp(record.timestamp);
    const observation = cacheObservation(record, agent, requestAt);
    if (observation) emit(observation);
  };
}

export function newCacheState(billing = { mode:'unknown', label:'billing unknown' }) {
  return { billing, observation: null, reminded: null, snoozeUntil: 0 };
}
export function acceptCacheObservation(state, observation) {
  if (!observation) { state.observation = null; state.reminded = null; return; }
  if (state.observation?.at != null && observation.at != null && observation.at < state.observation.at) return;
  state.observation = observation;
}
const tokens = n => n === null ? '?' : n >= 1e6 ? `${+(n/1e6).toFixed(1)}m` : n >= 1000 ? `${+(n/1000).toFixed(1)}k` : String(n);
const age = ms => ms < 60000 ? `${Math.floor(ms/1000)}s` : ms < 3600000 ? `${Math.floor(ms/60000)}m` : `${Math.floor(ms/3600000)}h`;
export function cacheWindow(seat, now = Date.now()) {
  const o = seat.cache?.observation;
  if (!seat.alive || seat.attention?.watcher?.state !== 'healthy' || !['idle','completed'].includes(seat.attention?.activity)
    || !o || o.at === null || o.at > now || !Number.isFinite(o.windowEndsAt)) return null;
  return { remaining: o.windowEndsAt - now, seconds: o.ttlSeconds };
}
export function cacheLine(seat, now = Date.now(), width = 24) {
  if (!CACHE_PROFILES[seat.agent]) return '';
  const o = seat.cache?.observation;
  if (!o) return 'cache unknown';
  const window = cacheWindow(seat, now);
  const metric = window ? `${tokens(o.written)} wrote` : o.read !== null ? `${tokens(o.read)} read` : `${tokens(o.written)} wrote`;
  const suffix = o.scope === 'session' ? 'total' : o.at !== null && o.at <= now ? `${age(now-o.at)} ago` : '';
  const timing = window ? window.remaining > 0 ? `~${age(window.remaining)}` : 'window elapsed' : '';
  const full = `cache ${metric}${timing || suffix ? ' · ' + (timing || suffix) : ''}`;
  if (full.length <= width) return full;
  if (timing) return window.remaining > 0 ? `cache write ${timing}` : 'cache write elapsed';
  return `cache ${metric}${o.scope === 'session' ? ' total' : ''}`;
}
export function cacheDetails(seat, now = Date.now()) {
  const cache = seat.cache, o = cache?.observation;
  const lines = [`Cache · ${cache?.billing?.label || 'billing unknown'}`];
  if (!o) return [...lines,'No cache usage reported by this history source.'];
  lines.push(`${o.scope === 'session' ? 'Session total' : 'Last request'}: ${tokens(o.read)} tokens read · ${tokens(o.written)} written`);
  lines.push(o.at !== null && o.at <= now ? `Observed ${age(now-o.at)} ago` : 'Observation time unknown');
  const window = cacheWindow(seat, now);
  lines.push(window ? `Write window ${window.remaining > 0 ? '~'+age(window.remaining)+' remaining' : 'elapsed'} (${window.seconds/60}m tier)` : 'Retention unknown; no countdown');
  if (window) lines.push('Estimate for observed writes; reuse is not guaranteed.');
  if (cache?.billing?.mode === 'subscription') lines.push('Observed tokens, not remaining plan allowance.');
  return lines;
}
export function cacheReminder(seat, enabled, now = Date.now()) {
  if (!enabled || !seat.cache || now < seat.cache.snoozeUntil) return null;
  const window = cacheWindow(seat, now), o = seat.cache.observation;
  if (!window || window.remaining <= 0 || window.remaining > Math.min(60000, window.seconds*200)) return null;
  const key = `${o.key}:${o.windowEndsAt}`;
  if (seat.cache.reminded === key) return null;
  seat.cache.reminded = key;
  return `${seat.seat || seat.agent}: cache write window ~${age(window.remaining)} left · Alt+U details`;
}
