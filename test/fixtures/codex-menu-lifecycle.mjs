import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {appendFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pty from 'node-pty';
import headless from '@xterm/headless';
import {codexStore} from './codex-store.mjs';
import {createInputFramer} from '../../station-input.mjs';
import {loadHistory} from '../../station-history.mjs';
import {readLedger} from '../../station-ledger.mjs';
const self=fileURLToPath(import.meta.url);

if(process.argv.includes('--agent')){
 if(process.argv.includes('--help')){console.log('--no-daemon');process.exit(0);}
 const root=process.env.STATION_HOME,id=randomUUID(),store=codexStore(root);
 const trace=e=>appendFileSync(path.join(root,'trace.jsonl'),JSON.stringify({id,...e})+'\n');
 store.thread(id,process.cwd(),process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE.replace('mrmak_chat_',''));
 store.turn(id,'initial','completed',0,'initial','Ready');trace({type:'launch'});
 let input='',menu=null,ordinal=2,pending;
 const ready=()=>process.stdout.write(`\x1b[2J\x1b[H  >_ OpenAI Codex (v0.166.0)\x1b[8;1H› ${input||'Ask Codex to do anything'}\x1b[10;1H  GPT-6-Astra high · ~/project\x1b[8;${3+input.length}H`);
 const showMenu=()=>process.stdout.write(`\x1b[2J\x1b[H${menu==='effort'?'Select Reasoning Level':menu==='model'?'Select Model and Effort':'Update Model Permissions'}\r\n\r\n› 1. Current\r\n  2. Other\r\n\r\n  enter select · esc back`);
 const finish=()=>{
  if(!pending)return;
  store.turn(id,pending.id,'completed',pending.ordinal,pending.text,'TABLE ANSWER '+id);pending=null;
  if(!menu)ready();trace({type:'finished'});
 };
 setInterval(()=>{
  const file=path.join(root,'finish-'+id);
  if(!existsSync(file)||!readFileSync(file,'utf8'))return;
  unlinkSync(file);finish();
 },40);
 const framer=createInputFramer(data=>{
  if(data==='\x1b'){
   menu=menu==='effort'?'model':null;
   if(menu)showMenu();else ready();return;
  }
  if(menu){
   trace({type:'menu-input',menu,data});
   if(data==='\r'){
    menu=menu==='model'?'effort':null;
    if(menu)showMenu();else ready();
   }
   return;
  }
  if(data==='\x1b[A'){input='/model';ready();return;}
  if(data.startsWith('\x1b[200~')){input+=data.slice(6,-6);trace({type:'paste'});ready();return;}
  if(data==='\r'){
   const text=input;input='';
   if(text==='/model'||text==='/permissions'){menu=text.slice(1);showMenu();return;}
   assert.ok(text.includes('Station table request'),'only table prompts reach native history');
   trace({type:'submit',text});
   const reference=text.match(/JSON-encoded path\): ("(?:\\.|[^"\\])*")\./);
   assert.ok(reference,'bounded Codex request');
   assert.ok(readFileSync(JSON.parse(reference[1]),'utf8').includes(text.match(/Station table request [a-f0-9-]{36}$/)[0]));
   pending={id:randomUUID(),ordinal,text};ordinal+=2;
   store.turn(id,pending.id,'inProgress',pending.ordinal,text,'');
   if(readFileSync(path.join(root,'mode'),'utf8')==='normal')finish();else ready();
   return;
  }
  if(!/[\x00-\x1f\x7f]/.test(data)){input+=data;ready();}
 });
 process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);process.stdin.resume();
 process.stdin.on('data',data=>framer.write(data));ready();
}else{
 const root=await mkdtemp(path.join(os.tmpdir(),'station-codex-menu-'));
 const empty=codexStore(root);empty.close();await writeFile(path.join(root,'mode'),'hold');
 await writeFile(path.join(root,process.platform==='win32'?'codex.cmd':'codex'),process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${self}" --agent %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${self}" --agent "$@"\n`,{mode:0o755});
 const env={...process.env,STATION_HOME:root,CODEX_HOME:root,CLAUDE_CONFIG_DIR:root,HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root};
 for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
 env.PATH=[root,path.dirname(process.execPath),...(process.platform==='win32'?[path.join(process.env.SystemRoot,'System32')]:['/usr/bin','/bin'])].join(path.delimiter);
 const term=new headless.Terminal({cols:160,rows:40,allowProposedApi:true});
 const child=pty.spawn(process.execPath,[path.resolve('station.mjs'),'--seats','codex,codex'],{cwd:root,env,cols:160,rows:40});
 let exited=false,runId;child.onData(data=>term.write(data));child.onExit(()=>exited=true);
 const screen=()=>Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(term.buffer.active.baseY+i)?.translateToString(true)||'').join('\n');
 const run=()=>{try{return loadHistory({dir:root}).find(r=>r.active);}catch(e){if(!runId&&/no such table/.test(e.message))return;throw e;}};
 const events=()=>{const ledger=readLedger(path.join(root,'station.db'));try{return ledger.events(runId);}finally{ledger.close();}};
 const trace=async()=> (await readFile(path.join(root,'trace.jsonl'),'utf8').catch(()=> '')).trim().split('\n').filter(Boolean).map(JSON.parse);
 const until=async(check,label)=>{for(let i=0;i<350&&!await check()&&!exited;i++)await delay(100);assert.ok(await check(),`${label}\n${root}\n${screen()}`);};
 const key=async data=>{child.write(data);await delay(180);};
 try{
  await until(()=>run()?.seats.length===2&&run().seats.every(s=>s.attention?.watcher.state==='healthy'),'healthy Codex seats');
  runId=run().id;const ids=run().seats.map(s=>s.nativeId);
  await key('\x1b`');await key('Codex menu recovery');await key('\r');
  await until(async()=> (await trace()).filter(e=>e.type==='submit').length===2&&run().seats.every(s=>s.attention.activity==='working'),'both opening requests running');
  await key('\x1b1');await key('\x1b[A');await until(()=>screen().includes('› /model'),'history recalled model command');
  await key('\r');await until(()=>screen().includes('Select Model and Effort'),'model menu');
  await key('\r');await until(()=>screen().includes('Select Reasoning Level'),'effort submenu');
  await key('\x1b2');await key('/permissions');await key('\r');await until(()=>screen().includes('Update Model Permissions'),'peer permission menu');
  for(const id of ids)await writeFile(path.join(root,'finish-'+id),'finish');
  await until(()=>events().some(e=>e.type==='table-held'&&e.payload.reason.includes('/model')),'table holds for model menu');
  assert.ok(run().seats.every(s=>s.attention.completionVersion===2&&s.attention.readVersion===0));
  await key('\x1b1');await key('\x1b');await until(()=>screen().includes('Select Model and Effort'),'nested Escape remains at parent');
  await key('\x1b`');await key('\r');await until(()=>screen().includes('Still held:'),'parent menu rejects retry');
  assert.equal((await trace()).filter(e=>e.type==='submit').length,2);
  await key('\x1b1');await key('\x1b');
  await writeFile(path.join(root,'mode'),'normal');await key('\x1b`');await key('\r');
  await until(()=>events().some(e=>e.type==='table-held'&&e.payload.reason.includes('/permissions')),'peer permission menu holds next turn');
  assert.equal((await trace()).filter(e=>e.type==='submit').length,3);
  await key('\x1b2');await key('\r'); // owner selects an option; simulated dialog closes
  await key('\x1b`');await key('\r');
  await until(()=>events().some(e=>e.type==='table-ended'&&e.payload.reason==='completed'),'same table completes');
  const submissions=(await trace()).filter(e=>e.type==='submit');
  assert.equal(submissions.length,6);assert.equal(new Set(submissions.map(e=>e.text)).size,6);
  assert.equal(events().filter(e=>e.type==='table-response-match').length,6);
  assert.equal(events().filter(e=>e.type==='table-started').length,1);
  assert.equal((await trace()).filter(e=>e.type==='launch').length,2);
  assert.ok((await trace()).filter(e=>e.type==='menu-input').every(e=>e.data==='\r'),'only owner selection keys enter menus');
  assert.deepEqual(run().seats.map(s=>s.nativeId),ids);
  assert.ok(run().seats.every(s=>s.attention.watcher.state==='healthy'&&s.attention.readVersion===0));
  await key('\x11');await until(()=>exited,'quit');console.log('Codex menu lifecycle passed');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{if(!exited)child.kill();term.dispose();}
 process.exit(process.exitCode||0);
}
