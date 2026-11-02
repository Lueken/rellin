// Input is evidence of intent, not evidence that a model turn started.
// Only bare, documented dialog commands belong here. Argument forms can apply
// settings directly; skills such as /review can start real model work.
const CLAUDE_MENUS = new Set(['/usage', '/status', '/model', '/config', '/settings', '/permissions', '/mcp', '/help', '/theme']);
// Codex 0.166 menu captures and the official developer-command reference.
// /status and /mcp print inline; /approvals is not supported by this version.
const CODEX_MENUS = new Set(['/model', '/permissions', '/skills', '/theme', '/statusline']);
const localCommand = (agent, text) => ({ claude: CLAUDE_MENUS, codex: CODEX_MENUS })[agent]?.has(text?.trim()) ? text.trim() : null;

// Read only the live cursor's single-line composer with provider-specific framing.
// Do not search old output, a menu selection, wrapped text or ghost suggestions.
export function nativeComposer(agent, terminal) {
  if (!['claude', 'codex'].includes(agent) || !terminal) return null;
  const buffer = terminal.buffer.active, y = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(y);
  const rule = row => /^[\s─━\-]{3,}$/.test(buffer.getLine(row)?.translateToString(true) || '');
  if (!line || line.isWrapped) return null;
  const before = line.translateToString(false, 0, buffer.cursorX);
  const after = line.translateToString(true, buffer.cursorX);
  if (agent === 'codex') {
    // Codex has no composer border. Its cursor row is separated by blank rows
    // from the live footer; a picker leaves its cursor on "enter select · esc
    // back", not on the selected numbered row. Never search prior transcript.
    const textAt = row => buffer.getLine(row)?.translateToString(true) || '';
    const footer = textAt(y + 2).trim();
    if (textAt(y - 1).trim() || textAt(y + 1).trim()) return null;
    const normalFooter = /^.+ (?:default|none|minimal|low|medium|high|xhigh|max|ultra) · \S/.test(footer)
      || /^(?:\? for shortcuts|tab to queue message|esc again to edit previous message)(?:\s|$)/.test(footer);
    const match = /^› (.*)$/.exec(before);
    const placeholder = match?.[1] === '' && after.trim() === 'Ask Codex to do anything';
    // /statusline can remove or reorder every footer field. The observed
    // empty-input placeholder at the cursor is sufficient for that return;
    // nonempty/history drafts still require a recognized footer.
    if (!normalFooter && !placeholder) return null;
    return match && (!after.trim() || placeholder) && !/^\d+[.)]\s/.test(match[1]) ? match[1] : null;
  }
  if (!rule(y - 1) || !rule(y + 1)) return null;
  const match = /^\s*[❯›>] (.*)$/.exec(before);
  const placeholder = match?.[1] === '' && /^Try ["“].+["”]$/.test(after.trim());
  return match && (!after.trim() || placeholder) ? match[1] : null;
}

// A key is only an attempt to leave a dialog. Nested menus may consume Esc or
// Enter. Release the delivery gate after a later redraw shows the real input.
export function observeNativeScreen(seat, terminal) {
  if (!seat.localCommand || seat.menuExitVersion == null || (seat.nativeScreenVersion || 0) <= seat.menuExitVersion) return;
  const draft = nativeComposer(seat.agent, terminal);
  if (draft === null) return;
  seat.localCommand = null; seat.menuExitVersion = null;
  seat.inputDraft = draft; seat.draftDirty = !!draft.trim();
}

export function observeNativeInput(seat, data, { prompt = false, terminal = null } = {}) {
  let draft = seat.inputDraft === undefined ? '' : seat.inputDraft;
  const pasted = data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~');
  if (pasted) {
    if (draft !== null) draft += data.slice(6, -6);
  } else if (data === '\x1b' || data === '\x03' || data === '\x15') {
    draft = '';
    if (seat.localCommand && (data === '\x1b' || data === '\x03')) seat.menuExitVersion = seat.nativeOutputVersion ?? seat.nativeScreenVersion ?? 0;
  } else if (data === '\x7f' || data === '\b') {
    if (draft !== null) draft = [...draft].slice(0, -1).join('');
  } else if (!/[\x00-\x1f\x7f]/.test(data)) {
    if (draft !== null) draft += data;
  } else if (data === '\r') {
    const visible = draft === null ? nativeComposer(seat.agent, terminal) : null;
    const local = !prompt && localCommand(seat.agent, draft === null ? visible : draft);
    seat.inputDraft = '';
    if (seat.localCommand) seat.menuExitVersion = seat.nativeOutputVersion ?? seat.nativeScreenVersion ?? 0;
    else if (local) { seat.localCommand = local; seat.menuExitVersion = null; }
    // History/cursor edits and slash commands may operate entirely inside the
    // CLI. An Enter there cannot establish that a model request was submitted.
    // Observe native events instead of arming a false progress failure.
    const ordinaryDraft = typeof draft === 'string' && !!draft.trim() && !draft.trimStart().startsWith('/');
    return { submitted: true, expectTurn: !local && !seat.localCommand && !prompt && ordinaryDraft };
  } else draft = null;
  seat.inputDraft = draft;
  return { submitted: false, expectTurn: false };
}
