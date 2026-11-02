const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';

// A terminal data event is a transport packet, not a key. Keep escape
// sequences and pasted text intact, but separate coalesced keys/mouse reports.
export function createInputFramer(send, { escapeMs = 40 } = {}) {
  let pending = '', timer;
  const emit = length => { const part = pending.slice(0, length); pending = pending.slice(length); send(part); };
  const drain = () => {
    while (pending) {
      if (pending.startsWith(PASTE_START)) {
        const end = pending.indexOf(PASTE_END, PASTE_START.length);
        if (end < 0) break;
        emit(end + PASTE_END.length); continue;
      }
      if (pending[0] === '\x1b') {
        if (pending.length === 1) {
          timer = setTimeout(() => { timer = null; emit(1); }, escapeMs);
          break;
        }
        if (pending[1] === '[') {
          const sequence = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(pending);
          if (!sequence) {
            const control = /[\x00-\x1f\x7f]/.exec(pending.slice(2));
            if (control) { emit(2 + control.index); continue; }
            break;
          }
          emit(sequence[0].length); continue;
        }
        if (pending[1] === 'O') { if (pending.length < 3) break; emit(3); continue; }
        if (pending[1] === ']') {
          const end = /\x07|\x1b\\/.exec(pending);
          if (!end) break;
          emit(end.index + end[0].length); continue;
        }
        emit(1 + [...pending.slice(1)][0].length); continue;
      }
      if (/[\x00-\x1f\x7f]/.test(pending[0])) { emit(1); continue; }
      emit(/^[^\x00-\x1f\x7f]+/.exec(pending)[0].length);
    }
    // An abandoned escape prefix must not hold every later key indefinitely.
    // A bracketed paste has explicit framing and is exempt from this timeout.
    if (pending && !pending.startsWith(PASTE_START) && !timer)
      timer = setTimeout(() => { timer = null; if (pending) emit(pending.length); }, escapeMs);
  };
  return {
    write(data) { clearTimeout(timer); timer = null; pending += data; drain(); },
    dispose() { clearTimeout(timer); pending = ''; },
  };
}

// All Rellin views temporarily own this same stream. Frame before emission
// so a shortcut that opens a modal hands subsequent keys to its new listener.
// Restore the original emitter when Rellin releases the terminal.
export function installInputFraming(input) {
  const original = input.emit;
  const framer = createInputFramer(part => original.call(input, 'data', part));
  const framed = function(event, ...args) {
    if (event !== 'data') return original.call(this, event, ...args);
    framer.write(args[0]); return this.listenerCount('data') > 0;
  };
  input.emit = framed;
  return () => { framer.dispose(); if (input.emit === framed) input.emit = original; };
}
