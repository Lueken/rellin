import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { codexStore } from './fixtures/codex-store.mjs';
import { findCodexChat, newerCodexRollout } from '../codex-history.mjs';
import { codexDbRecords } from '../codex-db.mjs';
import { createTurnWatcher } from '../station-turns.mjs';
import { readConversation } from '../station-conversation.mjs';
import { prepareResume } from '../station-history.mjs';

test('a discovered JSONL bootstrap upgrades to SQLite at the same path and tracks turns',async()=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'codex-upgrade-')),previous=process.env.CODEX_HOME;
 process.env.CODEX_HOME=home;
 const id=randomUUID(),owner=randomUUID(),events=[],identities=[];
 const folder=path.join(home,'sessions',...new Date().toISOString().slice(0,10).split('-'));
 const file=path.join(folder,`rollout-${new Date().toISOString().slice(0,10)}T00-00-00-${id}.jsonl`);
 await mkdir(folder,{recursive:true});
 await writeFile(file,JSON.stringify({type:'session_meta',payload:{id,cwd:home,source:'cli',originator:`mrmak_chat_${owner}`}})+'\n');
 let watcher,store;
 const until=async predicate=>{for(let i=0;i<60&&!predicate();i++)await delay(100);assert.ok(predicate());};
 try {
  watcher=createTurnWatcher({agent:'codex',cwd:home,nativeId:owner,onEvent:e=>events.push(e),onIdentity:id=>identities.push(id),progressTimeoutMs:6000});
  await until(()=>identities.length); assert.equal(watcher.health().state,'pending');
  watcher.expectProgress();
  store=codexStore(home);store.thread(id,home,owner);store.state.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(file,id);
  store.turn(id,'one','inProgress',0,'question','draft');
  await until(()=>events.some(e=>e.kind==='turn-started'));
  assert.equal(watcher.health().state,'healthy');
  store.turn(id,'one','completed',0,'question','answer');
  await until(()=>events.some(e=>e.kind==='completed'));
  assert.equal(await watcher.readFinal(),'answer');
  assert.equal(events.filter(e=>e.kind==='completed').length,1);
 } finally {watcher?.stop();store?.close();if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});

test('paginated Codex discovery requires the exact seat owner and accepts Windows extended paths', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-codex-db-')), store = codexStore(home);
  const id = randomUUID(), owner = randomUUID(), cwd = 'C:\\Work\\Project';
  try {
    store.thread(id, '\\\\?\\C:\\Work\\Project', owner);
    store.thread(randomUUID(), cwd, 'other-owner');
    const match = await findCodexChat({ id: owner, cwd }, { home });
    assert.equal(match?.id, id); assert.equal(match.storage, 'sqlite');
    assert.equal(await findCodexChat({ id: owner, cwd: 'C:\\elsewhere' }, { home }), null);
    store.thread(randomUUID(), cwd, owner, { threadSource: 'subagent' });
    assert.equal((await findCodexChat({ id: owner, cwd }, { home })).id, id);
    const newer = randomUUID(); store.thread(newer, cwd, owner, { stamp: '2026-10-30T00-01-00' });
    assert.equal((await newerCodexRollout({ id: owner, cwd }, match.file, { home })).id, newer);
    assert.equal((await newerCodexRollout({ id: owner, cwd }, match.file, { home, currentStorage: 'sqlite' })).id, newer);
    assert.equal(await findCodexChat({ id: owner, cwd }, { home }), null, 'ambiguous owners are not guessed');
  } finally { store.close(); }
});

test('paginated completion, reader and resume work without rollout files or replaying old answers', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'station-codex-db-')), store = codexStore(home);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  const id = randomUUID(), owner = randomUUID(), events = [], identities = [];
  let watcher;
  const until = async predicate => { for (let i = 0; i < 30 && !predicate(); i++) await delay(100); assert.ok(predicate()); };
  try {
    store.thread(id, home, owner); store.turn(id, 'old', 'completed', 0);
    const [restored] = await prepareResume({ cwd: home, seats: [{ agent: 'codex', nativeId: id }] });
    watcher = createTurnWatcher({ agent: 'codex', cwd: home, nativeId: owner, resumeId: id, boundary: restored.boundary, onEvent: event => events.push(event), onIdentity: value => identities.push(value) });
    await until(() => identities.length); await delay(450); assert.deepEqual(events.filter(event => event.kind !== 'watcher-state'), []);
    assert.equal(watcher.health().state, 'healthy');
    store.turn(id, 'new', 'inProgress', 2, 'continue', 'streaming');
    await until(() => events.some(event => event.kind === 'turn-started'));
    assert.ok(!events.some(event => event.kind === 'completed'));
    store.turn(id, 'new', 'completed', 2, 'continue', 'final answer');
    await until(() => events.some(event => event.kind === 'completed'));
    await delay(450); assert.equal(events.filter(event => event.kind === 'completed').length, 1);
    assert.equal(await watcher.readFinal(), 'final answer');
    assert.equal(await watcher.readUsage(), null);
    assert.equal((await readConversation({ agent: 'codex', nativeId: id }, home)).messages.at(-1).text, 'final answer');
    assert.equal(codexDbRecords(id, { maxBytes: 1 }).limited, true);
    store.turn(id, 'failed', 'failed', 4); await until(() => events.some(event => event.kind === 'attention'));
  } finally { watcher?.stop(); store.close(); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});
