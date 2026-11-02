import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { claudeTranscript } from './native-events.mjs';
import { codexSegments } from './codex-history.mjs';
import { codexDbThreads, codexDbRecords } from './codex-db.mjs';
import { transcriptMessages, transcriptText } from './mobile-transcript.mjs';
import { showFiles } from './station-files.mjs';
import { parseMouse, wrappedLinkAt, openLink } from './station-links.mjs';
import { seatLabel, clipLabel } from './station-vocabulary.mjs';
import { createShelfDrag, shelfSeatAt } from './station-view.mjs';
import { grokText, grokSynthetic, grokFinal } from './grok-records.mjs';

export const readableText = value => stripVTControlCharacters(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const label = value => readableText(value).replace(/\n/g, ' ');

export function conversationMessages(records, agent, limit = 1000) {
  const messages = agent === 'grok'
    ? records.filter(item => !grokSynthetic(item) && (item.type==='user' || grokFinal(item)) && grokText(item)).map((item, index) => ({ id: item.id || String(index), role: item.type, text: grokText(item), at: item.timestamp || '' }))
    : transcriptMessages(records, agent, limit + 1);
  return { messages: messages.slice(-limit).map(item => ({ ...item, text: readableText(item.text).slice(0, 100000) || '[Media attachment]', at: label(item.at) })), limited: messages.length > limit || messages.some(item => item.text.length >= 100000) };
}

export async function readConversation(seat, cwd) {
  if (!['claude', 'codex', 'grok'].includes(seat.agent)) throw new Error(`Readable history is not available for ${seat.agent} yet.`);
  const validId = seat.agent === 'grok' ? /^[a-z0-9][a-z0-9_-]{0,127}$/i : /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (!validId.test(seat.nativeId || '')) throw new Error('No native conversation ID has been captured for this seat yet. Return to its terminal, or refresh after its first message.');
  if (seat.agent === 'codex' && codexDbThreads({ id: seat.nativeId }).length) {
    const source = codexDbRecords(seat.nativeId);
    const parsed = conversationMessages(source.records, 'codex');
    return { messages: parsed.messages, limited: source.limited || parsed.limited };
  }
  const files = seat.agent === 'codex' ? await codexSegments(seat.nativeId)
    : [seat.agent === 'claude' ? await claudeTranscript(cwd, seat.nativeId)
      : path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(cwd), seat.nativeId, 'chat_history.jsonl')];
  if (!files.length) throw new Error('Native conversation history was not found.');
  let source;
  try { source = await transcriptText(files); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Native history is not on disk yet, or has been removed. Press r to retry.'); throw error; }
  const records = source.text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const parsed = conversationMessages(records, seat.agent);
  return { messages: parsed.messages, limited: source.truncated || parsed.limited };
}

export function filteredMessages(messages, query) {
  const search = query.toLowerCase();
  return messages.filter(message => message.text.toLowerCase().includes(search));
}

export function messageLines(text, width) {
  const size = Math.max(1, width);
  return readableText(text).split('\n').flatMap(line => {
    const chars = [...line], lines = [];
    do { lines.push(chars.splice(0, size).join('')); } while (chars.length);
    return lines;
  });
}

export function conversationKey(chunk, state) {
  if (chunk === '\x11') return { type: 'quit' };
  if (state.searching) {
    if (chunk === '\x1b') return { type: 'clear' };
    if (chunk === '\r') return { type: 'searched' };
    if (chunk === '\x7f' || chunk === '\b') return { type: 'erase' };
    if (chunk.startsWith('\x1b[200~')) return { type: 'text', text: label(chunk.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '')) };
    return /[\x00-\x1f\x7f-\x9f]/.test(chunk) ? { type: 'none' } : { type: 'text', text: chunk };
  }
  if (chunk === 'f') return { type: 'files' };
  if (chunk === 'm' && state.readToken) return { type: 'acknowledge', token: state.readToken };
  return ({ '\x1b': { type: 'close' }, '\x1bt': { type: 'close' }, q: { type: 'close' }, '\t': { type: 'seat' }, r: { type: 'refresh' }, c: { type: 'copy' }, '/': { type: 'search' }, '[': { type: 'message', delta: -1 }, ']': { type: 'message', delta: 1 }, '\x1b[D': { type: 'message', delta: -1 }, '\x1b[C': { type: 'message', delta: 1 }, '\x1b[A': { type: 'scroll', delta: -1 }, '\x1b[B': { type: 'scroll', delta: 1 }, '\x1b[5~': { type: 'page', delta: -1 }, '\x1b[6~': { type: 'page', delta: 1 }, '\x1b[H': { type: 'first' }, '\x1b[F': { type: 'last' } })[chunk] || { type: 'none' };
}

export function renderConversation(state, seats, width = 100, height = 30) {
  const messages = filteredMessages(state.messages, state.query), message = messages[state.index];
  const bodyHeight = Math.max(1, height - 7);
  const body = messageLines(message?.text || state.error || (state.loading ? 'Reading conversation…' : state.query ? 'No messages match this search.' : 'No readable messages yet. Press r to refresh.'), width - 2);
  const scroll = Math.max(0, Math.min(state.scroll, body.length - bodyHeight));
  const header = ` Conversation · ${state.seat + 1} ${seatLabel(seats[state.seat])} · ${messages.length ? state.index + 1 : 0}/${messages.length}${state.query ? ' matches' : ' messages'}`;
  const lines = [header, ` ${message ? `${label(message.role)}  ${message.at}` : ''}${state.limited ? '  [Recent history only: search is limited to the loaded tail]' : ''}`, ''];
  lines.push(...body.slice(scroll, scroll + bodyHeight).map(line => ` ${line}`));
  while (lines.length < height - 4) lines.push('');
  lines.push(` ${state.readToken ? `m read v${state.readToken.version} · ` : ''}${state.searching ? 'Search: ' : state.query ? 'Filter: ' : ''}${state.query}${state.searching ? '_' : ''}`);
  lines.push(' ←→ message · ↑↓ scroll · PgUp/PgDn page · / search · c copy');
  lines.push(' Tab seat · r refresh · f files · Ctrl+click link · Esc back · ^Q quit');
  lines.push(` ${label(state.notice || '')}`);
  return { lines: lines.slice(0, height).map(line => clipLabel(line, Math.max(1, width - 1))), scroll, maxScroll: Math.max(0, body.length - bodyHeight), message };
}

export function captureReadToken(seat) {
  const a = seat.attention;
  return a?.completionVersion > (a.readVersion || 0) ? { nativeId: seat.nativeId, version: a.completionVersion } : null;
}
export function applyReadToken(seat, token, acknowledge) {
  if (!token || token.nativeId !== seat.nativeId || !Number.isSafeInteger(token.version)) return false;
  return acknowledge(token.version);
}

// Read-only overlay; all input stays here and never reaches an agent's PTY.
export function showConversation({ seats, cwd, focus = 0, activateLink = openLink, acknowledge = null, frame = null }) {
  return new Promise(resolve => {
    let state = { seat: focus, messages: [], index: 0, scroll: 0, query: '', searching: false, loading: false, error: null, limited: false, notice: null };
    let closed = false, generation = 0, filesOpen = false;
    const shelfTimer = frame ? setInterval(() => { if (!closed && !filesOpen) process.stdout.write(bounds().chrome); }, 1000) : null;
    let mouseAnchor = null;
    const resizeShelf = createShelfDrag();
    const bounds = () => frame?.(state.seat, state.readToken) || { region: { x: 0, y: 0, width: process.stdout.columns, height: process.stdout.rows }, chrome: '' };
    const draw = () => {
      if (closed) return;
      const { region, chrome } = bounds();
      const rendered = renderConversation(state, seats, region.width, region.height);
      state.scroll = rendered.scroll;
      process.stdout.write('\x1b[?25l\x1b[0m\x1b[2J' + chrome + rendered.lines.map((line, row) => `\x1b[${region.y + row + 1};${region.x + 1}H${line}`).join(''));
      return rendered;
    };
    const refresh = async () => {
      const ticket = ++generation;
      const readToken = acknowledge ? captureReadToken(seats[state.seat]) : null;
      state = { ...state, messages: [], loading: true, error: null, notice: null, index: 0, scroll: 0, readToken: null };
      draw();
      try {
        const result = await readConversation(seats[state.seat], cwd);
        if (closed || ticket !== generation) return;
        state = { ...state, ...result, index: Math.max(0, filteredMessages(result.messages, state.query).length - 1), loading: false,
          readToken: result.messages.some(message => message.role === 'assistant') ? readToken : null };
      } catch (error) { if (closed || ticket !== generation) return; state = { ...state, loading: false, error: readableText(error.message) }; }
      draw();
    };
    const finish = quit => {
      closed = true;
      clearInterval(shelfTimer);
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', draw);
      process.stdout.write('\x1b[?2004l');
      resolve({ quit });
    };
    const onData = async chunk => {
      if (filesOpen) return;
      if (/\x1b\[</.test(chunk)) {
        for (const event of parseMouse(chunk)) {
          if (frame && resizeShelf(event,process.stdout.columns,process.stdout.rows)) { mouseAnchor=null; draw(); continue; }
          if (event.kind === 'press') {
            const { region } = bounds();
            if (frame && event.x <= region.x) {
              const shelf={x:0,y:0,width:region.x,height:region.height};
              const target=shelfSeatAt(shelf,seats.length,state.seat,event.x-1,event.y-1);
              if(target===state.seat && (event.y-3)%6===3) {
                return onData(state.readToken ? 'm' : '\x1b');
              }
              if(target>=0 && target!==state.seat) {state.seat=target;state.query='';state.limited=false;return void refresh();}
              continue;
            }
            const rendered = renderConversation(state, seats, region.width, region.height);
            const row = event.y - region.y - 4;
            const link = event.ctrl && rendered.message && row >= 0 && row < Math.max(1, region.height - 7) && event.x > region.x
              ? wrappedLinkAt(rendered.message.text, region.width - 2, row + rendered.scroll, event.x - region.x - 2, cwd) : null;
            mouseAnchor = link ? { link, x: event.x, y: event.y } : null;
          } else if (event.kind === 'drag') mouseAnchor = null;
          else if (event.kind === 'release') {
            const pressed = mouseAnchor; mouseAnchor = null;
            if (pressed && pressed.x === event.x && pressed.y === event.y) {
              state.notice = 'Opening link…'; draw();
              try { state.notice = (await activateLink(pressed.link)).notice; }
              catch (error) { state.notice = `Could not open link: ${readableText(error.message)}`; }
              draw();
            }
          }
        }
        return;
      }
      const action = conversationKey(chunk, state);
      state.notice = null;
      if (action.type === 'close' || action.type === 'quit') return finish(action.type === 'quit');
      if (action.type === 'seat') { state.seat = (state.seat + 1) % seats.length; state.query = ''; state.limited = false; return void refresh(); }
      if (action.type === 'refresh') return void refresh();
      if (action.type === 'acknowledge') {
        const changed = applyReadToken(seats[state.seat], action.token, version => acknowledge?.(state.seat, version));
        state.readToken = null;
        const a = seats[state.seat].attention;
        state.notice = changed ? `Read through v${action.token.version}. ${Math.max(0, a.completionVersion - a.readVersion)} unread; r refreshes the snapshot.` : 'That read version is no longer available. Press r to refresh.';
        draw(); return;
      }
      if (action.type === 'files') {
        const message = filteredMessages(state.messages, state.query)[state.index];
        filesOpen = true;
        const result = await showFiles({ cwd, label: seatLabel(seats[state.seat]), read: async () => ({ messages: message ? [message] : [], limited: state.limited }), redrawBackground: draw });
        filesOpen = false;
        if (result.quit) return finish(true);
        state.notice = result.notice; draw(); return;
      }
      const count = filteredMessages(state.messages, state.query).length;
      if (action.type === 'message') { state.index = Math.max(0, Math.min(count - 1, state.index + action.delta)); state.scroll = 0; }
      if (action.type === 'first' || action.type === 'last') { state.index = action.type === 'first' ? 0 : Math.max(0, count - 1); state.scroll = 0; }
      if (action.type === 'scroll' || action.type === 'page') state.scroll += action.delta * (action.type === 'page' ? Math.max(1, bounds().region.height - 7) : 1);
      if (action.type === 'search') state.searching = true;
      if (action.type === 'searched') state.searching = false;
      if (action.type === 'clear') { state.query = ''; state.searching = false; state.index = 0; state.scroll = 0; }
      if (action.type === 'text' || action.type === 'erase') {
        state.query = action.type === 'text' ? (state.query + action.text).slice(0, 500) : [...state.query].slice(0, -1).join('');
        state.index = 0; state.scroll = 0;
      }
      if (action.type === 'copy') {
        const message = filteredMessages(state.messages, state.query)[state.index];
        if (message) { process.stdout.write(`\x1b]52;c;${Buffer.from(message.text).toString('base64')}\x1b\\`); state.notice = 'Copy requested through your terminal clipboard.'; }
      }
      draw();
    };
    process.stdout.write('\x1b[?2004h');
    process.stdin.on('data', onData);
    process.stdout.on('resize', draw);
    void refresh();
  });
}
