import { cleanLabel, clipLabel } from './station-vocabulary.mjs';
export const STATION_MOUSE = '\x1b[?9001l\x1b[?1000l\x1b[?1003l\x1b[?1002h\x1b[?1006h\x1b[?2004h';

// The app owns the alternate screen. Individual views only paint into it.
export function openStationScreen(output = process.stdout) {
  let closed = false;
  output.write('\x1b[?1049h\x1b[?9001l\x1b[?25l\x1b[H RELLIN');
  return () => {
    if (closed) return;
    closed = true;
    output.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?9001l\x1b[r\x1b[0m\x1b[?1049l\x1b[?25h');
  };
}

// Keep the current view visible during asynchronous transitions. Fast work
// finishes without a spinner flash; slow work updates only the footer.
export async function withLoading(label, work, { output = process.stdout, delayMs = 120, intervalMs = 120 } = {}) {
  let timer, shown = false, index = 0;
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  const paint = text => output.write(`\x1b7\x1b[${output.rows || 24};1H\x1b[0m\x1b[2K${clipLabel(text, Math.max(1,(output.columns || 80)-1))}\x1b8`);
  const draw = () => { shown = true; paint(` ${frames[index++ % frames.length]} ${cleanLabel(label)}`); };
  const pending = setTimeout(() => { draw(); timer = setInterval(draw, intervalMs); }, delayMs);
  try { return await work(); }
  finally { clearTimeout(pending); clearInterval(timer); if (shown) paint(''); }
}
