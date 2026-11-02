// The station's conversational table (table-mode.md §7/§8, mockup 6), as a
// pure core: tableReduce drives the state machine, compose* build the exact
// prompts seats receive, renderTable paints the merged transcript. The
// station owns timers, watchers and PTY writes; nothing here touches IO.
//
// Flow: round 1 is blind-parallel — every member answers the topic without
// seeing another answer; answers are staged and released together,
// attributed, in seat order. Rounds 2+ serialize the floor in seat order;
// each floor prompt carries exactly the entries that seat has not seen.
// Chair interjections enter the transcript immediately and ride the next
// composed prompt; they never interrupt a running turn.
import { elapsedLabel } from './station-view.mjs';
import { attentionLabel, seatLabel as displaySeat, posture, READ_ONLY } from './station-vocabulary.mjs';
import { renderMarkdown, graphemes, graphemeWidth, displayWidth as plainWidth, clipCells as clipLabel } from './station-markdown.mjs';

export function newTable({ topic, members, maxRounds = 3, at }) {
  const seen = {};
  for (const member of members) seen[member] = 1;
  return {
    topic, startedAt: at, maxRounds, round: 1, phase: 'blind',
    members: [...members], floor: null, awaiting: {}, staged: {},
    entries: [{ round: 1, speaker: 'chair', text: topic, at }],
    seen, pauseAfterTurn: false, endReason: null,
    held: {}, heldPhase: null,
  };
}

export function seatLabel(index, seats) {
  const seat = seats[index];
  return `seat ${index + 1} · ${seat.seat}${seat.model && seat.model !== 'default' ? ' · ' + seat.model : ''}`;
}

export function composeBlindPrompt({ topic, maxRounds, seatIndex, members, seats }) {
  return `[Table · round 1 of ${maxRounds}] Topic: ${topic}

You are ${seatLabel(seatIndex, seats)} of ${members.length} at a table chaired by the owner. Every seat is answering this same prompt right now, blind: nobody sees another seat's answer until all have finished, and your answer will then be shared with the table attributed to you.

Use relevant work, constraints and findings already established in this conversation to shape your opening. Briefly surface the prior evidence the other seats need, distinguishing observations from assumptions. Do not assume access to their individual conversations. The table recommends an approach; the chair decides what to accept.

Answer in one message: your position, your reasoning, and what you would check before committing. Commit to a position — do not hedge toward a middle answer for safety. Do not ask the chair questions this round, and do not change any files.`;
}

export function composeFloorPrompt({ table, seatIndex, seats }) {
  const unseen = table.entries.slice(table.seen[seatIndex] ?? 0);
  const blocks = unseen.map(entry => entry.speaker === 'chair'
    ? `── chair ──\n${entry.text}`
    : `── ${seatLabel(entry.speaker, seats)} (round ${entry.round}) ──\n${entry.text}`);
  return `[Table · round ${table.round} of ${table.maxRounds}] Topic: ${table.topic}

Since your last turn, the table said:

${blocks.join('\n\n')}

You now hold the floor, ${seatLabel(seatIndex, seats)}. The chair wants your independent judgment — polite convergence is a failure mode of this table, and agreement must be earned (table-mode.md §6). In one message:
1. First, name the weakest claim or your strongest point of disagreement in the entries above, with evidence. No evidence? Label it a hypothesis and name the check that would settle it; a preference is legitimate if you call it one.
2. Only then say where you genuinely agree — and what would change your mind.
3. End with your current recommendation, referring to seats by number.
Do not soften a real disagreement to be agreeable, and do not manufacture one if, after step 1, you find the position genuinely sound — say so and defend it. Do not change any files.`;
}

const ledger = record => ({ type: 'ledger', record });
const sendTo = (table, seat, seats, at, prompt) => {
  table.awaiting[seat] = { round: table.round, sentAt: at, seenBefore: table.seen[seat] };
  table.seen[seat] = table.entries.length;
  return { type: 'send', seat, round: table.round, text: prompt };
};

// Grant the floor to `seat`, or pause before it if the chair asked.
function grantFloor(table, seat, seats, at, effects) {
  table.floor = seat;
  if (table.pauseAfterTurn) {
    table.pauseAfterTurn = false;
    table.phase = 'paused';
    effects.push(ledger({ type: 'table-pause' }));
    return;
  }
  table.phase = 'floor';
  effects.push(sendTo(table, seat, seats, at, composeFloorPrompt({ table, seatIndex: seat, seats })));
  effects.push(ledger({ type: 'table-floor', round: table.round, seat }));
}

// After `seat` finished (answered, timed out or died), move the table on.
function advance(table, seat, seats, at, effects) {
  const order = table.members;
  const index = order.indexOf(seat);
  const next = order[index + 1];
  if (next !== undefined) return grantFloor(table, next, seats, at, effects);
  if (table.round >= table.maxRounds) {
    table.phase = 'done'; table.endReason = 'completed'; table.floor = null;
    effects.push(ledger({ type: 'table-ended', reason: 'completed' }));
    return;
  }
  table.round += 1;
  grantFloor(table, order[0], seats, at, effects);
}

function releaseBlind(table, seats, at, effects) {
  for (const member of table.members) {
    const held = table.staged[member];
    if (held) table.entries.push({ round: 1, speaker: member, text: held.text, elapsedMs: held.elapsedMs, at, chairInterleaved: held.chairInterleaved, timedOut: held.timedOut });
  }
  table.staged = {};
  effects.push(ledger({ type: 'table-release', round: 1, seats: table.members.map(member => member) }));
  if (table.maxRounds <= 1) {
    table.phase = 'done'; table.endReason = 'completed';
    effects.push(ledger({ type: 'table-ended', reason: 'completed' }));
    return;
  }
  table.round = 2;
  grantFloor(table, table.members[0], seats, at, effects);
}

// tableReduce(table|null, event, seats) → [table|null, effects]
export function tableReduce(table, event, seats) {
  const effects = [];
  if (event.type === 'table-start') {
    const next = newTable(event);
    effects.push(ledger({ type: 'table-started', topic: event.topic, maxRounds: next.maxRounds, readOnly: 'instruction-only', seats: event.members.map(member => ({ seat: seats[member].seat, agent: seats[member].agent, model: seats[member].model, nativeId: seats[member].nativeId, launchPosture: seats[member].bypass ? 'bypass' : 'manual' })) }));
    for (const member of next.members) {
      effects.push(sendTo(next, member, seats, event.at, composeBlindPrompt({ topic: event.topic, maxRounds: next.maxRounds, seatIndex: member, members: next.members, seats })));
    }
    return [next, effects];
  }
  if (!table) return [table, effects];
  const next = { ...table, held: { ...table.held }, awaiting: { ...table.awaiting }, staged: { ...table.staged }, seen: { ...table.seen }, entries: [...table.entries], members: [...table.members] };
  switch (event.type) {
    case 'hold':
      if (next.phase === 'done' || !next.awaiting[event.seat]) break;
      if (next.phase !== 'held') next.heldPhase = next.phase;
      next.phase = 'held';
      next.held[event.seat] = event.reason;
      next.seen[event.seat] = next.awaiting[event.seat].seenBefore;
      effects.push(ledger({ type: 'table-held', seat: seats[event.seat].seat, reason: event.reason }));
      break;
    case 'retry':
      if (next.phase !== 'held') break;
      next.phase = next.heldPhase;
      next.heldPhase = null;
      for (const seat of Object.keys(next.held).map(Number)) {
        // Only deliveries that never sent Enter can enter this set. Retain
        // successful peer answers and use a new request identity on retry.
        const prompt = next.awaiting[seat].round === 1
          ? composeBlindPrompt({ topic: next.topic, maxRounds: next.maxRounds, seatIndex: seat, members: next.members, seats })
          : composeFloorPrompt({ table: next, seatIndex: seat, seats });
        effects.push(sendTo(next, seat, seats, event.at, prompt));
      }
      next.held = {};
      effects.push(ledger({ type: 'table-retry' }));
      break;
    case 'answer': case 'timeout': {
      const seat = event.seat;
      const pending = next.awaiting[seat];
      if (!pending) break;
      delete next.awaiting[seat];
      const text = event.type === 'timeout' ? '(no answer within the turn timeout)' : event.text;
      const entry = { text, elapsedMs: event.elapsedMs ?? (event.at - pending.sentAt), chairInterleaved: event.chairInterleaved, timedOut: event.type === 'timeout' };
      effects.push(ledger({ type: event.type === 'timeout' ? 'table-timeout' : 'table-answer', seat: seats[seat].seat, round: pending.round, text, elapsedMs: entry.elapsedMs }));
      if (next.phase === 'blind' || pending.round === 1) {
        next.staged[seat] = entry;
        if (!Object.keys(next.awaiting).length) releaseBlind(next, seats, event.at, effects);
      } else {
        next.entries.push({ round: pending.round, speaker: seat, at: event.at, ...entry });
        advance(next, seat, seats, event.at, effects);
      }
      break;
    }
    case 'interject':
      next.entries.push({ round: next.round, speaker: 'chair', text: event.text, at: event.at });
      effects.push(ledger({ type: 'table-interject', text: event.text }));
      break;
    case 'pause':
      if (next.phase === 'blind' || next.phase === 'floor') {
        next.pauseAfterTurn = !next.pauseAfterTurn;
        effects.push(ledger({ type: next.pauseAfterTurn ? 'table-pause' : 'table-resume' }));
      }
      break;
    case 'resume':
      if (next.phase === 'paused' && next.floor !== null) {
        next.phase = 'floor';
        effects.push(sendTo(next, next.floor, seats, event.at, composeFloorPrompt({ table: next, seatIndex: next.floor, seats })));
        effects.push(ledger({ type: 'table-resume' }));
        effects.push(ledger({ type: 'table-floor', round: next.round, seat: next.floor }));
      }
      break;
    case 'end':
      next.phase = 'done'; next.endReason = event.reason || 'chair'; next.awaiting = {}; next.held = {};
      effects.push(ledger({ type: 'table-ended', reason: next.endReason }));
      break;
    case 'seat-died': {
      const seat = event.seat;
      if (!next.members.includes(seat)) break;
      if (next.phase === 'held') {
        next.phase = 'done'; next.endReason = 'seat-exited'; next.awaiting = {}; next.held = {};
        effects.push(ledger({ type: 'table-ended', reason: 'seat-exited' }));
        break;
      }
      next.members = next.members.filter(member => member !== seat);
      next.entries.push({ round: next.round, speaker: seat, text: '(seat exited mid-table)', at: event.at, died: true });
      effects.push(ledger({ type: 'table-seat-died', seat: seats[seat].seat, round: next.round }));
      const wasAwaited = !!next.awaiting[seat];
      delete next.awaiting[seat];
      if (!next.members.length) {
        next.phase = 'done'; next.endReason = 'all-seats-dead';
        effects.push(ledger({ type: 'table-ended', reason: 'all-seats-dead' }));
      } else if (next.phase === 'blind' && wasAwaited && !Object.keys(next.awaiting).length) {
        releaseBlind(next, seats, event.at, effects);
      } else if (next.phase !== 'blind' && wasAwaited) {
        advance(next, seat, seats, event.at, effects);
      }
      break;
    }
  }
  return [next, effects];
}

// ── Rendering (mockup 6) ────────────────────────────────────────────────────

export function renderTable({ table, ui, seats, width, height, colorOf, now, notice, x = 0, shelf = false }) {
  const rows = [];
  const header = table
    ? ` RELLIN · table` + ' '.repeat(Math.max(2, width - 18 - plainHeaderRight(table, seats).length)) + plainHeaderRight(table, seats)
    : ' RELLIN · table';
  rows.push('\x1b[1m RELLIN · table\x1b[0m' + (table ? '\x1b[2m' + header.slice(17) + '\x1b[0m' : ''));
  for (const [index, seat] of (shelf ? [] : seats).entries()) {
    const tracking = seat.attention?.watcher?.state || 'unknown';
    rows.push(clipLabel(` ${index + 1} ${displaySeat(seat)} · ${attentionLabel(seat, now)} · tracking: ${tracking}`, width));
  }
  rows.push(...wrapInput(` Read-only: ${READ_ONLY}. Launch permissions are unchanged.`, Math.max(10, width)));
  if (notice) rows.push(...wrapInput(` ${notice}`, Math.max(1, width)).slice(0, 2));
  rows.push('');
  const body = [];
  if (table) {
    let round = 0;
    for (const entry of table.entries) {
      if (entry.round !== round) {
        round = entry.round;
        body.push(`\x1b[2m ${('── round ' + round + ' ').padEnd(width - 2, '─')}\x1b[0m`);
      }
      pushEntry(body, entry, seats, width, colorOf);
    }
    // In-progress markers for the current round.
    for (const member of table.members) {
      if (table.held?.[member]) {
        body.push(gutter(member, seats, colorOf) + 'held · Enter rechecks readiness');
      } else if (table.awaiting[member]) {
        const marker = `${attentionLabel(seats[member], now)} · Alt+${member + 1} pane`;
        body.push(gutter(member, seats, colorOf) + marker);
      } else if (table.phase === 'blind' && table.staged[member]) {
        body.push(gutter(member, seats, colorOf) + '\x1b[2;32m✓ answered · held until all finish\x1b[0m');
      } else if (table.phase === 'floor' && table.members.indexOf(member) > table.members.indexOf(table.floor)) {
        body.push(gutter(member, seats, colorOf) + '\x1b[2mwaiting for the floor\x1b[0m');
      }
    }
    if (table.phase === 'paused') body.push('\x1b[33m paused — Enter resumes\x1b[0m');
    if (table.phase === 'held') body.push('\x1b[33m held — resolve the seat, then Enter retries the unsent step\x1b[0m');
    if (table.phase === 'done') body.push(`\x1b[2m table ended (${table.endReason})\x1b[0m`);
  }
  // The input box grows with the typed text: wrapped lines each take a row,
  // and the transcript viewport shrinks to make room.
  // Keep the tail of a long draft visible without pushing its cursor/footer
  // off screen. The full draft remains intact for submission and backspace.
  const inputLines = ui.input ? wrapInput(ui.input, Math.max(1, width - 6)).slice(-Math.max(1, Math.min(6, height - rows.length - 4))) : null;
  const viewHeight = Math.max(0, height - rows.length - 3 - (inputLines ? inputLines.length : 1));
  const scroll = Math.min(ui.scroll, Math.max(0, body.length - viewHeight));
  const window = body.slice(Math.max(0, body.length - viewHeight - scroll), body.length - scroll || undefined);
  while (window.length < viewHeight) window.push('');
  rows.push(...window);
  // Input box.
  const placeholder = notice ? `\x1b[31m${notice}\x1b[0m`
    : !table ? '\x1b[2mtype a topic and press Enter to convene the table\x1b[0m'
    : table.phase === 'held' ? 'Resolve the seat, then Enter retries the unsent step'
    : table.phase === 'paused' ? '\x1b[2mEnter resumes · interject first if you want\x1b[0m'
    : '\x1b[2minterject, or Enter to let the round finish\x1b[0m';
  rows.push(`┌${'─'.repeat(Math.max(0, width - 2))}┐`);
  if (inputLines) for (const [index, line] of inputLines.entries()) rows.push(`│ ${index ? ' ' : '›'} ${line}`);
  else rows.push(`│ › ${placeholder}`);
  const hints = width >= 110 ? ' Enter send · Alt+V paste · Space pause · Alt+-/= turn limit · Alt+E end ' : width >= 65 ? ' Enter send · Alt+V paste · Space pause · Alt+E end ' : ' Enter send · Alt+V paste ';
  const hint = clipLabel(hints, Math.max(0, width - 2));
  rows.push(`└${hint}${'─'.repeat(Math.max(0, width - plainWidth(hint) - 2))}┘`);
  // Status line.
  const tabs = seats.map((seat, index) => {
    return ` ${colorOf(seat)}${index + 1} ${displaySeat(seat)} ${attentionLabel(seat, now)}\x1b[0m `;
  }).join('');
  const state = (table ? `table · round ${table.round}/${table.maxRounds}` : 'table')
    + (ui.waitMinutes ? ` · limit ${ui.waitMinutes}m` : '');
  rows.push(shelf ? ` ${state}` : `${tabs}  \x1b[2m${state} · Alt+\` Console · ^Q quit\x1b[0m`);
  return rows.slice(0, height).map((row, index) => {
    const text = clipLabel(row, width);
    return `\x1b[${index + 1};${x + 1}H\x1b[0m` + text + ' '.repeat(Math.max(0, width - plainWidth(text)));
  }).join('') + cursorTo(Math.min(height - 2, rows.length - 2), Math.min(width - 1, 4 + (inputLines ? plainWidth(inputLines[inputLines.length - 1]) : 0)) + x);
}

const cursorTo = (row, column) => `\x1b[${row};${column + 1}H\x1b[?25h`;

const wrapInput = (text, width) => {
  const lines = [];
  // Compose canonically equivalent accents for ConPTY, whose diff renderer
  // can otherwise miscount decomposed marks when emitting full-width rows.
  // This is presentation-only; ui.input and stored prompt text stay untouched.
  for (const raw of String(text).normalize('NFC').split('\n')) {
    let line = '', used = 0;
    for (const cluster of graphemes(raw)) {
      const size = graphemeWidth(cluster);
      if (used + size > width && line) { lines.push(line); line = ''; used = 0; }
      line += size > width ? '�' : cluster;
      used += Math.min(size, width);
    }
    lines.push(line);
  }
  return lines;
};

function plainHeaderRight(table, seats) {
  const floor = table.phase === 'floor' && table.floor !== null ? ` · floor: ${table.floor + 1} ${displaySeat(seats[table.floor])}` : table.phase === 'paused' ? ' · paused' : table.phase === 'done' ? ' · ended' : '';
  return clipLabel(`round ${table.round} of ${table.maxRounds}${floor} · ${table.members.length} seats · topic: ${table.topic}`, 90);
}

const gutter = (index, seats, colorOf) => {
  const label = `${index + 1} ${seats[index].seat.slice(0, 10)}${posture(seats[index]) ? ' ' + posture(seats[index]) : ''}`;
  return ` ${colorOf(seats[index])}\x1b[1m${label}${' '.repeat(Math.max(0, 24 - plainWidth(label)))}\x1b[0m  `;
};

function pushEntry(body, entry, seats, width, colorOf) {
  if (entry.speaker === 'chair') {
    const lines = wrapInput(entry.text, Math.max(1, width - 8));
    lines.forEach((line, index) => body.push((index === 0 ? '\x1b[1m you ›\x1b[0m  ' : '        ') + line));
  } else {
    const seat = seats[entry.speaker];
    const lines = formattedEntry(entry, width - 5, seat.agent);
    const time = entry.elapsedMs === undefined ? '' : entry.timedOut ? ' · turn limit' : ` · ✓ ${elapsedLabel(entry.elapsedMs / 1000)}`;
    body.push(` ${colorOf(seat)}\x1b[1m${entry.speaker + 1} ${displaySeat(seat)}\x1b[0m${time}`);
    for (const line of lines) body.push(` ${colorOf(seat)}│\x1b[0m  ${line}`);
    if (entry.chairInterleaved) body.push('    \x1b[2mchair spoke during this turn\x1b[0m');
  }
  body.push('');
}

const entryCache = new WeakMap();
function formattedEntry(entry, width, agent) {
  const previous = entryCache.get(entry);
  if (previous?.width === width && previous.agent === agent && previous.text === entry.text) return previous.lines;
  const lines = renderMarkdown(entry.text, Math.max(1, width), agent);
  entryCache.set(entry, { width, agent, text: entry.text, lines });
  return lines;
}
