import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import headless from '@xterm/headless';
import {nativeComposer,observeNativeInput,observeNativeScreen} from '../station-native-input.mjs';
import {readinessProblem,guardedDelivery} from '../station-coordination.mjs';
const capture=JSON.parse(readFileSync(new URL('./fixtures/codex-menu-screens.json',import.meta.url),'utf8'));
const ready=()=>({agent:'codex',alive:true,watcher:{},attention:{lifecycle:'running',source:'native',activity:'completed',completionVersion:2,readVersion:1,watcher:{state:'healthy'}}});
const terminal=()=>new headless.Terminal({cols:capture.cols,rows:capture.rows,allowProposedApi:true});
const paint=async (seat,term,name)=>{
 const {rows,cursor}=typeof name==='string'?capture.screens[name]:name;
 const position=cursor.x===capture.cols?`\x1b[${cursor.y+1};${capture.cols}H `:`\x1b[${cursor.y+1};${cursor.x+1}H`;
 await new Promise(resolve=>term.write('\x1b[2J\x1b[H'+rows.join('\r\n')+position,resolve));
 seat.nativeScreenVersion=(seat.nativeScreenVersion||0)+1;observeNativeScreen(seat,term);
};

test('installed Codex captures distinguish the live composer from every supported menu',async()=>{
 const term=terminal(),seat=ready();
 try{for(const name of Object.keys(capture.screens)){
  await paint(seat,term,name);
  const expected=name==='model-draft'?'/model':name==='permissions-draft'?'/permissions':name.endsWith('-menu')||name==='model-exit'?null:'';
  assert.equal(nativeComposer('codex',term),expected,name);
 }}finally{term.dispose();}
});

test('Codex bare menu commands gate typing, paste and visible history recall without inventing turns',async()=>{
 const term=terminal();
 try{
  for(const command of ['/model','/permissions','/skills','/theme','/statusline']){
   for(const data of [command,`\x1b[200~${command}\x1b[201~`]){
    const seat=ready(),before=structuredClone(seat.attention);
    observeNativeInput(seat,data);
    assert.equal(observeNativeInput(seat,'\r').expectTurn,false);
    assert.equal(seat.localCommand,command);assert.ok(readinessProblem(seat));
    assert.deepEqual(seat.attention,before);
   }
  }
  for(const command of ['/status','/mcp','/approvals','/model example','/review','/compact','/config','/model\nextra']){
   const seat=ready();observeNativeInput(seat,`\x1b[200~${command}\x1b[201~`);observeNativeInput(seat,'\r');
   assert.equal(seat.localCommand,undefined,command);
  }
  for(const key of ['\x1b[A','\x1b[D','\t']){
   const seat=ready();observeNativeInput(seat,key);await paint(seat,term,'permissions-draft');
   observeNativeInput(seat,'\r',{terminal:term});assert.equal(seat.localCommand,'/permissions');
  }
 }finally{term.dispose();}
});

test('real model/effort screens keep table delivery blocked through nested Escape and release on returned input',async()=>{
 const term=terminal(),seat=ready(),writes=[];
 const send=()=>guardedDelivery({seat,proc:{write:text=>writes.push(text)},current:()=>true,prompt:()=>null,refresh:async()=>{},wait:async()=>{},text:'table',onSubmit:()=>{}});
 try{
  await paint(seat,term,'start');observeNativeInput(seat,'/model');observeNativeInput(seat,'\r');
  await paint(seat,term,'model-menu');await assert.rejects(send(),/close \/model/);
  observeNativeInput(seat,'\r',{prompt:true});await paint(seat,term,'model-effort-menu');
  await assert.rejects(send(),/close \/model/);
  observeNativeInput(seat,'\x1b');await paint(seat,term,'model-exit');
  await assert.rejects(send(),/close \/model/);assert.deepEqual(writes,[]);
  observeNativeInput(seat,'\x1b');await paint(seat,term,'model-exit-parent');
  assert.equal(readinessProblem(seat),null);await send();assert.deepEqual(writes,['\x1b[200~table\x1b[201~','\r']);
  assert.equal(seat.attention.completionVersion,2);assert.equal(seat.attention.readVersion,1);
 }finally{term.dispose();}
});

test('Codex menu dismissal rejects stale output, preserves drafts, and never reads old transcript mentions',async()=>{
 const term=terminal(),seat=ready();
 try{
  await paint(seat,term,'start');observeNativeInput(seat,'/permissions');observeNativeInput(seat,'\r');
  seat.nativeOutputVersion=seat.nativeScreenVersion+1;observeNativeInput(seat,'\x1b');
  await paint(seat,term,'start');assert.equal(seat.localCommand,'/permissions');
  delete seat.nativeOutputVersion;
  const edited=structuredClone(capture.screens.start);edited.rows[7]='› unfinished draft';edited.cursor.x=18;
  await paint(seat,term,edited);assert.equal(seat.localCommand,null);assert.match(readinessProblem(seat),/draft/);
  for(const alteration of ['footer','suffix','menu-row']){
   const view=structuredClone(capture.screens['model-draft']);
   if(alteration==='footer')view.rows[view.cursor.y+2]='  enter select · esc back';
   if(alteration==='suffix')view.rows[view.cursor.y]+=' extra';
   if(alteration==='menu-row'){view.rows[view.cursor.y]='› 1. /model';view.cursor.x=11;}
   await paint(ready(),term,view);assert.equal(nativeComposer('codex',term),null,alteration);
  }
 }finally{term.dispose();}
});

test('changing or removing the status line still releases at the observed empty Codex input',async()=>{
 const term=terminal();
 try{for(const footer of ['', '  project · main · 94% context left']){
  const seat=ready();observeNativeInput(seat,'/statusline');observeNativeInput(seat,'\r');
  await paint(seat,term,'statusline-menu');observeNativeInput(seat,'\r');
  const view=structuredClone(capture.screens.start);view.rows[view.cursor.y+2]=footer;
  await paint(seat,term,view);assert.equal(seat.localCommand,null);assert.equal(readinessProblem(seat),null);
 }}finally{term.dispose();}
});
