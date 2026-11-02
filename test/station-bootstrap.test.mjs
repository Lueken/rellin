import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import headless from '@xterm/headless';
import { createTurnWatcher } from '../station-turns.mjs';
import { readinessProblem, guardedDelivery, freshPromptReady } from '../station-coordination.mjs';
import { codexStore } from './fixtures/codex-store.mjs';

const until = async fn => { for (let i=0;i<60&&!fn();i++) await delay(40); assert.ok(fn()); };
const fresh = () => ({ agent:'claude', alive:true, watcher:{canBootstrap:()=>true}, attention:{lifecycle:'running',activity:'idle',source:'process',watcher:{state:'pending'}} });

test('fresh admission needs explicit prompt evidence and cannot bypass errors, menus or owner drafts', () => {
  assert.ok(readinessProblem(fresh()));
  assert.equal(readinessProblem(fresh(),{fresh:true}),null);
  for (const patch of [{inputVersion:1},{resumeId:'old'}, {draftDirty:true}, {watcher:{canBootstrap:()=>false}}]) assert.ok(readinessProblem({...fresh(),...patch},{fresh:true}));
  assert.ok(readinessProblem(fresh(),{fresh:true,prompt:{}}));
  assert.equal(readinessProblem({...fresh(),inputVersion:2,bootstrapInputVersion:2},{fresh:true}),null,'recognized startup-menu interaction can precede first request');
});

test('native fresh input recognition checks brand, cursor and empty input rather than screen silence', async () => {
  for (const [agent,header,prompt] of [['claude','Claude Code v2.1','❯ '],['codex','OpenAI Codex','› Ask Codex to do anything']]) {
    const term = new headless.Terminal({cols:100,rows:24,allowProposedApi:true});
    const paint = async text => new Promise(r=>term.write(`\x1b[2J\x1b[H${header}\x1b[20;1H${text}\x1b[20;3H`,r));
    await paint(prompt); assert.equal(freshPromptReady(agent,term),true);
    await paint('› unfinished draft'); assert.equal(freshPromptReady(agent,term),false);
    await paint(prompt); await new Promise(r=>term.write('\x1b[22;1Hesc to interrupt\x1b[20;3H',r));
    assert.equal(freshPromptReady(agent,term),false);
    term.dispose();
  }
});

test('fresh delivery rechecks approval and owner input between paste and Enter', async () => {
  for (const change of ['approval','owner','fault']) {
    const seat=fresh(),writes=[]; let prompt=null;
    await assert.rejects(guardedDelivery({seat,proc:{write:x=>writes.push(x)},current:()=>true,prompt:()=>prompt,refresh:async()=>{},capture:async()=>({}),freshReady:()=>true,text:'first topic',onSubmit:()=>assert.fail('must not submit'),wait:async()=>{
      if(change==='approval')prompt={};
      if(change==='owner')seat.inputVersion=1;
      if(change==='fault')seat.watcher.canBootstrap=()=>false;
    }}),/Enter was not sent/);
    assert.equal(writes.length,1);
  }
});

test('first Claude request can precede its file and still requires its exact final answer', async () => {
  const home=await mkdtemp(path.join(os.tmpdir(),'station-bootstrap-claude-')), previous=process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR=home;
  const id=randomUUID(),events=[],watcher=createTurnWatcher({agent:'claude',cwd:home,nativeId:id,onEvent:e=>events.push(e)});
  try {
    const request=await watcher.captureRequest('exact first prompt',{bootstrap:true});
    assert.equal(request.bootstrap,true);
    const folder=path.join(home,'projects',home.replace(/[^a-zA-Z0-9]/g,'-'));await mkdir(folder,{recursive:true});
    await writeFile(path.join(folder,`${id}.jsonl`),[
      {type:'user',uuid:'first',message:{content:'exact first prompt'}},
      {type:'assistant',message:{id:'reply',stop_reason:'end_turn',content:[{type:'text',text:'first answer'}]}},
    ].map(JSON.stringify).join('\n')+'\n');
    await watcher.refresh();
    assert.equal((await watcher.readResponse(request)).text,'first answer');
    assert.equal(watcher.canBootstrap(),false);
  } finally {watcher.stop();if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous;}
});

test('first Codex request binds only to its owned discovered conversation', async () => {
  const home=await mkdtemp(path.join(os.tmpdir(),'station-bootstrap-codex-')),previous=process.env.CODEX_HOME;
  process.env.CODEX_HOME=home;
  const owner=randomUUID(),id=randomUUID(),events=[],watcher=createTurnWatcher({agent:'codex',cwd:home,nativeId:owner,onEvent:e=>events.push(e)});
  let store;
  try {
    const request=await watcher.captureRequest('first Codex topic',{bootstrap:true});
    store=codexStore(home);
    const other=randomUUID();store.thread(other,home,randomUUID());store.turn(other,'wrong','completed',0,'first Codex topic','wrong seat');
    assert.equal(await watcher.readResponse(request),null);
    store.thread(id,home,owner);store.turn(id,'right','completed',0,'first Codex topic','right seat');
    await until(()=>events.some(e=>e.kind==='completed'));
    assert.equal((await watcher.readResponse(request)).text,'right seat');
    assert.equal(request.boundId,id);
    assert.equal(watcher.canBootstrap(),false);
  } finally {watcher.stop();store?.close();if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;}
});
