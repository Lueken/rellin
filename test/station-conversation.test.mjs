import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationKey, conversationMessages, filteredMessages, messageLines, readableText, renderConversation } from '../station-conversation.mjs';
import { keyAction, reduce, stationSeats } from '../station.mjs';
import { startupReduce } from '../station-startup.mjs';

test('native readers omit sidechain and tool traffic and retain final streaming revisions', () => {
  const parsed = conversationMessages([
    { type: 'user', message: { content: 'Question' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
    { type: 'assistant', message: { id: 'reply', content: [{ type: 'text', text: 'Partial' }] } },
    { type: 'assistant', message: { id: 'reply', content: [{ type: 'text', text: 'Final answer' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'exec', input: 'private tool content' }] } },
  ], 'claude');
  assert.deepEqual(parsed.messages.map(message => message.text), ['Question', 'Final answer']);
  const codex = conversationMessages([
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'text', text: 'injected instructions' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'User question' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Answer' } },
  ], 'codex');
  assert.deepEqual(codex.messages.map(message => message.text), ['User question', 'Answer']);
});

test('Grok messages and limits are explicit; message controls cannot escape the viewer', () => {
  const result = conversationMessages([{ type: 'user', content: 'old' }, { type: 'assistant', content: 'hello\x1b]52;c;evil\x07\x1b[2J world' }], 'grok', 1);
  assert.equal(result.limited, true);
  assert.equal(result.messages[0].text, 'hello world');
  assert.equal(readableText('a\tb\r\nc'), 'a    b\nc');
  assert.deepEqual(messageLines('abcd\n\n🙂x', 2), ['ab', 'cd', '', '🙂x']);
});

test('search keeps full message text for reading/copying and scroll stays in bounds', () => {
  const messages = [{ role: 'user', at: '', text: 'Alpha' }, { role: 'assistant', at: '', text: 'Keep this full ANSWER\nsecond line\nthird line' }];
  assert.deepEqual(filteredMessages(messages, 'answer'), [messages[1]]);
  const state = { seat: 0, messages, index: 0, query: 'answer', scroll: 999, limited: true };
  const rendered = renderConversation(state, [{ agent: 'claude' }], 100, 12);
  assert.equal(rendered.message.text, messages[1].text);
  assert.equal(rendered.scroll, rendered.maxScroll);
  assert.ok(rendered.lines.length <= 12);
  assert.match(rendered.lines.join('\n'), /Recent history only/);
});

test('reader navigation and search never produce agent-input actions', () => {
  assert.equal(conversationKey('x', {}).type, 'none');
  assert.equal(conversationKey('\r', {}).type, 'none');
  assert.equal(conversationKey('q', { searching: true }).type, 'text');
  assert.equal(conversationKey('\x1b', { searching: true }).type, 'clear');
  assert.equal(conversationKey('\x1b', {}).type, 'close');
  assert.equal(conversationKey('\x11', {}).type, 'quit');
  assert.equal(conversationKey('c', {}).type, 'copy');
  const state = { seats: stationSeats('claude'), focus: 0, composer: null };
  assert.deepEqual(reduce(state, keyAction('\x1bt', state))[1], [{ type: 'transcript' }]);
  assert.equal(keyAction('\x1bt', { ...state, usageOpen: true }).type, 'none');
});

test('saved history can be read without resuming or taking ownership of an active run', () => {
  const run = { id: 'run', active: true, cwd: process.cwd(), seats: [{ agent: 'claude', nativeId: 'id' }] };
  const [state, effect] = startupReduce({ page: 'sessions', query: '', index: 0 }, { type: 'read' }, { runs: [run] });
  assert.equal(state.page, 'sessions');
  assert.deepEqual(effect, { type: 'read', run });
});
