// Activity is time in a natively observed working state, not token usage.
// Unknown intervals stay unknown even when a neighbouring sample is healthy.
export function activityBuckets(series, now = Date.now(), count = 8, duration = 15000) {
  const samples = [...series].sort((a, b) => a.at - b.at);
  const end = Math.ceil(now / duration) * duration;
  return Array.from({ length: count }, (_, index) => {
    const from = end - (count - index) * duration, to = Math.min(now, from + duration);
    let cursor = from, state = null, working = 0, known = true;
    const accumulate = until => {
      if (until <= cursor) return;
      if (!state || state.watcher?.state !== 'healthy' || state.source !== 'native' || state.lifecycle !== 'running') known = false;
      else if (state.activity === 'working') working += until - cursor;
      cursor = until;
    };
    for (const sample of samples) {
      if (sample.at <= from) { state = sample.snapshot; continue; }
      if (sample.at >= to) break;
      accumulate(sample.at); state = sample.snapshot;
    }
    accumulate(to);
    return known && state && to > from ? working / (to - from) : null;
  });
}

export const activitySparkline = buckets => buckets.map(value => value == null ? '·' : '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(value * 8))]).join('');
