// Runtime facts, independent of focus, rendering, notifications and navigation.
// `acknowledge` is deliberately an explicit API for the later UX pass.
export function initialAttention(previous = null) {
  const completionVersion = Number.isSafeInteger(previous?.completionVersion) && previous.completionVersion >= 0 ? previous.completionVersion : 0;
  const readVersion = Math.max(0, Math.min(completionVersion, Number.isSafeInteger(previous?.readVersion) ? previous.readVersion : 0));
  return {
    schemaVersion: 1, lifecycle: 'starting', activity: 'idle', source: 'process',
    completionVersion, readVersion, unread: completionVersion > readVersion,
    lastCompletionId: previous?.lastCompletionId || null,
    lastCompletedAt: previous?.lastCompletedAt || null,
    completionIds: Array.isArray(previous?.completionIds) ? previous.completionIds.filter(id => typeof id === 'string') : [],
    turnStartedAt: null, changedAt: null, waitReason: null, promptId: null,
    error: null, providerCode: null, promptKind: null, exitCode: null,
    watcher: { state: 'pending', error: null },
  };
}

export function reduceAttention(state, event) {
  const at = event.at ?? Date.now();
  const change = patch => ({ ...state, ...patch, changedAt: at });
  if (event.type === 'acknowledge') {
    // A UI acknowledges the version it actually displayed, not "whatever is
    // latest now". A stale acknowledgement leaves newer completions unread.
    if (!Number.isSafeInteger(event.version) || event.version <= state.readVersion || event.version > state.completionVersion) return state;
    return change({ readVersion: event.version, unread: event.version < state.completionVersion });
  }
  if (['stopped', 'failed'].includes(state.lifecycle)) return state;
  switch (event.type) {
    case 'watcher-state': {
      if (state.watcher?.state === 'error') return state; // Restart is the explicit recovery boundary.
      if (state.watcher?.state === event.state && state.watcher?.error === (event.error || null)) return state;
      return change({ watcher: { state: event.state, error: event.error || null }, ...(event.state === 'error' ? { activity: 'failed', source: 'watcher', error: 'watcher-failed', turnStartedAt: null } : {}) });
    }
    case 'started': return state.lifecycle === 'running' ? state : change({ lifecycle: 'running', source: 'process' });
    case 'submitted':
    case 'turn-started':
      if (state.activity === 'working' && (event.type === 'submitted' || state.source === 'native')) return state;
      return change({ activity: 'working', source: event.type === 'submitted' ? 'input' : 'native', turnStartedAt: state.turnStartedAt ?? at, waitReason: null, promptId: null, error: null, providerCode: null });
    case 'prompt':
      if (state.activity === 'failed' || !event.id || state.promptId === event.id) return state;
      return change({ activity: 'waiting', source: 'screen', waitReason: 'prompt', promptId: event.id, promptKind: event.kind || 'choice' });
    case 'prompt-cleared':
      if (state.waitReason !== 'prompt') return state;
      return change({ activity: 'working', source: 'screen', turnStartedAt: state.turnStartedAt ?? at, waitReason: null, promptId: null });
    case 'quiet':
      // Silence can never prove completion, nor clear an error or a prompt.
      if (state.activity !== 'working' || event.native) return state;
      return change({ activity: 'idle', source: 'screen', turnStartedAt: null });
    case 'completed': {
      if (!event.id || state.completionIds.includes(event.id)) return state;
      return change({ activity: 'completed', source: 'native', completionVersion: state.completionVersion + 1, unread: true,
        lastCompletionId: event.id, lastCompletedAt: at, completionIds: [...state.completionIds, event.id],
        turnStartedAt: null, waitReason: null, promptId: null, error: null, providerCode: null });
    }
    case 'interrupted': return change({ activity: 'idle', source: 'native', turnStartedAt: null, waitReason: null, promptId: null, error: null });
    case 'timeout':
      if (state.waitReason === 'timeout' || state.activity === 'failed') return state;
      return change({ activity: 'waiting', source: 'timer', waitReason: 'timeout', promptId: null });
    case 'error':
      if (state.activity === 'failed' && state.error === event.code && state.providerCode === (event.providerCode ?? null)) return state;
      return change({ activity: 'failed', source: 'native', error: event.code || 'provider-error', providerCode: event.providerCode ?? null, turnStartedAt: null, waitReason: null, promptId: null });
    case 'launch-failed':
      return change({ lifecycle: 'failed', activity: 'failed', source: 'process', error: 'launch-failed', turnStartedAt: null });
    case 'stopped':
      return change({ lifecycle: 'stopped', source: 'process', activity: state.activity === 'working' || state.activity === 'waiting' ? 'idle' : state.activity, turnStartedAt: null, waitReason: null, promptId: null });
    case 'exited': {
      const failed = event.code !== 0;
      return change({ lifecycle: failed ? 'failed' : 'stopped', activity: failed ? 'failed' : state.activity === 'completed' ? 'completed' : 'idle', source: 'process', error: failed ? 'process-exit' : null, exitCode: event.code ?? null, turnStartedAt: null, waitReason: null, promptId: null });
    }
    default: return state;
  }
}

// Keep existing terminal presentation compatible; unread is not a UI policy yet.
export function legacyStatus(attention) {
  if (attention.watcher?.state === 'error') return 'needs';
  if (attention.activity === 'working') return 'working';
  if (['waiting', 'failed'].includes(attention.activity)) return 'needs';
  return 'ready';
}

export function createAttentionTracker(seats, persist) {
  for (const seat of seats) seat.attention = initialAttention(seat.attention);
  return {
    snapshot(index) { return structuredClone(seats[index].attention); },
    dispatch(index, event) {
      const seat = seats[index];
      if (!seat) throw new Error('Unknown attention seat.');
      const next = reduceAttention(seat.attention, event);
      if (next === seat.attention) return false;
      persist(index, next, event.type);
      seat.attention = next;
      seat.status = legacyStatus(next);
      seat.turnStart = next.turnStartedAt;
      return true;
    },
    acknowledge(index, version) { return this.dispatch(index, { type: 'acknowledge', version }); },
  };
}
