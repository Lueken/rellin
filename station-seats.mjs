import { FIELDS, fieldOptions } from './station-setup.mjs';
import { stripVTControlCharacters } from 'node:util';
import { seatLabel, attentionLabel, emphasizePosture } from './station-vocabulary.mjs';

const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function nextSeatName(agent, seats) {
  const used = new Set(seats.map(seat => seat.seat));
  let n = 1;
  while (used.has(n === 1 ? agent : `${agent}-${n}`)) n++;
  return n === 1 ? agent : `${agent}-${n}`;
}
export function removedSeatNavigation(state, removed, count) {
  const focus = Math.max(0, Math.min(count - 1, state.focus > removed ? state.focus - 1 : state.focus));
  const address = state.address === 'all' ? 'all' : state.address.filter(index => index !== removed).map(index => index > removed ? index - 1 : index);
  return { focus, address: address === 'all' || address.length ? address : [focus], composer: null, selection: null, view: state.view === 'table' ? 'console' : state.view };
}
export function seatMutationGuard({ count, operation, tableActive, handoffPending, busy }) {
  if (busy) throw new Error('A seat operation or clipboard paste is still finishing.');
  if (tableActive) throw new Error('End the table discussion before changing its seats.');
  if (handoffPending) throw new Error('Wait for the handoff to finish before changing seats.');
  if (operation === 'add' && count >= 4) throw new Error('All four seats are occupied. Close one before adding another.');
  if (operation === 'close' && count <= 1) throw new Error('Keep one seat open. Add another first, or quit Rellin.');
}

export function renderSeatManager(state, seats, columns = 100, rows = 30) {
  const width = Math.max(20, Math.min(92, columns - 2)), inner = width - 4;
  const lines = ['Manage seats', ''];
  if (state.adding) {
    lines.push('Add an agent');
    FIELDS.forEach((field, index) => lines.push(`${index === state.field ? '>' : ' '} ${field}: ${field === 'mode' && state.config[field] === 'auto' ? 'BYPASS' : state.config[field]}`));
    lines.push('', '↑↓ / Tab field · ←→ change · Enter add · Esc cancel');
  } else {
    seats.forEach((seat, index) => lines.push(`${index === state.index ? '>' : ' '} ${index + 1} ${seatLabel(seat)} · ${attentionLabel(seat)} · ${seat.model || 'default'} · ${seat.effort || 'default'}`));
    lines.push('', 'a add · r restart selected · x close selected · ↑↓ seat · Esc back');
    if (state.confirm) {
      const seat = seats[state.index];
      lines.push('', state.confirm === 'close' ? `Close ${seatLabel(seat)}? Its process stops; its conversation stays in history.`
        : `Restart ${seatLabel(seat)}? ${seat.nativeId ? 'Resume its saved conversation.' : 'No captured conversation: start a fresh chat.'}`);
      lines.push('Any current turn will stop. Enter confirms · Esc cancels');
    }
  }
  lines.push('', state.busy ? 'Working… Other agents keep running.' : state.error || '');
  const body = lines.flatMap(line => {
    const chars = [...clean(line)], wrapped = [];
    do { wrapped.push(chars.splice(0, inner).join('')); } while (chars.length);
    return wrapped;
  }).slice(0, Math.max(1, rows - 4));
  const top = Math.max(1, Math.floor((rows - body.length - 2) / 2) + 1), left = Math.max(1, Math.floor((columns - width) / 2) + 1);
  const frame = ['┌' + '─'.repeat(width - 2) + '┐', ...body.map(line => '│ ' + line.padEnd(inner) + ' │'), '└' + '─'.repeat(width - 2) + '┘'];
  return '\x1b[?25l\x1b[0m' + frame.map((line, index) => `\x1b[${top + index};${left}H\x1b[48;5;236m\x1b[38;5;252m${emphasizePosture(line)}\x1b[0m`).join('');
}

export function showSeatManager({ getSeats, focus, getOptions, operate, redrawBackground = () => {} }) {
  return new Promise(resolve => {
    let state = { index: focus, field: 0, adding: false, confirm: null, config: null, busy: false, error: null }, options, closed = false;
    const draw = () => { if (!closed) { redrawBackground(); process.stdout.write(renderSeatManager(state, getSeats(), process.stdout.columns, process.stdout.rows)); } };
    const finish = quit => { closed = true; process.stdin.removeListener('data', onData); process.stdout.removeListener('resize', draw); resolve({ quit }); };
    const onData = async chunk => {
      if (chunk === '\x11') return finish(true);
      if (state.busy) return;
      if (chunk === '\x1b') {
        if (state.confirm || state.adding) { state.confirm = null; state.adding = false; state.error = null; draw(); return; }
        return finish(false);
      }
      if (state.confirm && chunk !== '\r') return;
      state.error = null;
      if (chunk === '\r' && (state.adding || state.confirm)) {
        state.busy = true; draw();
        try { await operate(state.adding ? 'add' : state.confirm, state.index, state.config); if (!closed) finish(false); }
        catch (error) { state.error = clean(error.message); state.confirm = null; }
        finally { state.busy = false; draw(); }
        return;
      }
      if (state.adding) {
        if (chunk === '\t' || chunk === '\x1b[B') state.field = (state.field + 1) % FIELDS.length;
        if (chunk === '\x1b[A') state.field = (state.field + FIELDS.length - 1) % FIELDS.length;
        if (chunk === '\x1b[C' || chunk === '\x1b[D') {
          const field = FIELDS[state.field], choices = fieldOptions(field, state.config, options), delta = chunk === '\x1b[C' ? 1 : -1;
          state.config[field] = choices[(choices.indexOf(state.config[field]) + delta + choices.length) % choices.length];
          if (field === 'agent') { state.config.model = 'default'; state.config.effort = 'default'; state.config.mode = 'manual'; }
          if (field === 'model') state.config.effort = 'default';
        }
      } else if (chunk === 'a') {
        if (getSeats().length >= 4) { state.error = 'All four seats are occupied. Close one first.'; return draw(); }
        state.busy = true; draw();
        try {
          options ||= await getOptions();
          if (!options.available.length) throw new Error('No installed agent CLIs were found.');
          const agent = options.available.find(id => !getSeats().some(seat => seat.agent === id)) || options.available[0];
          state.config = { agent, model: 'default', effort: 'default', mode: 'manual' }; state.field = 0; state.adding = true;
        } catch (error) { state.error = clean(error.message); }
        finally { state.busy = false; }
      } else if (chunk === 'r' || chunk === 'x') state.confirm = chunk === 'r' ? 'restart' : 'close';
      else if (chunk === '\x1b[A' || chunk === '\x1b[B') state.index = Math.max(0, Math.min(getSeats().length - 1, state.index + (chunk === '\x1b[A' ? -1 : 1)));
      draw();
    };
    process.stdin.on('data', onData); process.stdout.on('resize', draw); draw();
  });
}
