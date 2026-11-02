import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pty from 'node-pty';
import { codexStore } from './codex-store.mjs';
import { loadHistory } from '../../station-history.mjs';
import { readLedger } from '../../station-ledger.mjs';
import { TABLE_INLINE_BYTES } from '../../station-table-delivery.mjs';

const self=fileURLToPath(import.meta.url);
if(process.argv.includes('--agent')) {
  if(process.argv.includes('--help')) {console.log('--no-daemon');process.exit(0);}
  const root=process.env.STATION_HOME,claude=process.argv.includes('--session-id');
  const id=claude?process.argv[process.argv.indexOf('--session-id')+1]:randomUUID();
  const trace=entry=>appendFileSync(path.join(root,'trace.jsonl'),JSON.stringify({id,agent:claude?'claude':'codex',...entry})+'\n');
  process.on('uncaughtException',error=>{trace({type:'error',message:error.stack});process.exit(1);});
  trace({type:'launch'});
  const ready=()=>process.stdout.write(`\x1b[2J\x1b[H${claude?'Claude Code':'OpenAI Codex'}\x1b[8;1H${claude?'❯ ':'› Ask Codex to do anything'}\x1b[8;3H`);
  ready();
  let input='',pasting=false,ordinal=0,store;
  // Decode across chunks: a large ConPTY paste can split a UTF-8 character.
  process.stdin.setEncoding('utf8');process.stdin.setRawMode?.(true);process.stdin.resume();
  process.stdin.on('data',async chunk=>{
    const data=String(chunk);
    if(data.includes('\x1b[200~'))pasting=true;
    input+=data.replace(/\x1b\[200~|\x1b\[201~/g,'');
    if(data.includes('\x1b[201~'))pasting=false;
    if(pasting||!data.includes('\r'))return;
    const text=input.replace(/\r/g,'');input='';trace({type:'submit',text});
    if(!claude) {
      assert.ok(Buffer.byteLength(text)<=TABLE_INLINE_BYTES,'Codex receives bounded terminal input');
      const reference=text.match(/JSON-encoded path\): ("(?:\\.|[^"\\])*")\./);
      if(reference) {
        const file=JSON.parse(reference[1]),body=await readFile(file,'utf8');
        assert.ok(body.includes(text.match(/Station table request [a-f0-9-]{36}$/)[0]));
        trace({type:'request-read',file,body});
      }
    }
    const response=`ANSWER ${id} round ${ordinal/2+1}\n`+`EVIDENCE ${id} 漢字\n`.repeat(60);
    if(claude) {
      if(ordinal===0) {
        await delay(32000); // Native history can arrive after the 30s watchdog.
        // Keep the pending interval observable on a loaded Windows runner.
        while(!await readFile(path.join(root,'release-native'),'utf8').catch(()=>'')) await delay(50);
      }
      const folder=path.join(root,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));await mkdir(folder,{recursive:true});
      const record=r=>appendFileSync(path.join(folder,`${id}.jsonl`),JSON.stringify(r)+'\n');
      record({type:'user',uuid:randomUUID(),message:{content:text}});
      record({type:'file-history-delta',messageId:randomUUID(),snapshotMessageId:randomUUID(),trackingPath:'scratch/check.mjs',backup:{backupFileName:null,version:1,backupTime:new Date().toISOString()},timestamp:new Date().toISOString()});
      record({type:'assistant',message:{id:randomUUID(),stop_reason:'end_turn',content:[{type:'text',text:response}]}});
    } else {
      store ||= codexStore(root);
      store.thread(id,process.cwd(),process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE.replace('mrmak_chat_',''));
      store.turn(id,randomUUID(),'completed',ordinal,text,response);
    }
    ordinal+=2;ready();
  });
} else {
  const root=await mkdtemp(path.join(os.tmpdir(),'station-table-bootstrap-'));
  // Create only empty database schemas, not threads or turns, before launch.
  const empty=codexStore(root);empty.close();
  for(const agent of ['claude','codex'])await writeFile(path.join(root,process.platform==='win32'?`${agent}.cmd`:agent),process.platform==='win32'?`@echo off\r\n"${process.execPath}" "${self}" --agent %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${self}" --agent "$@"\n`,{mode:0o755});
  const env={...process.env,STATION_HOME:root,CODEX_HOME:root,CLAUDE_CONFIG_DIR:root,HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root};
  for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
  env.PATH=[root,path.dirname(process.execPath),...(process.platform==='win32'?[path.join(process.env.SystemRoot,'System32')]:['/usr/bin','/bin'])].join(path.delimiter);
  const proc=pty.spawn(process.execPath,[path.resolve('station.mjs'),'--seats','claude,codex,claude,codex'],{cwd:root,env,cols:160,rows:40});
  let output='',exited=false;proc.onData(data=>output=(output+data).slice(-8000));proc.onExit(()=>exited=true);
  const run=()=>loadHistory({dir:root}).find(r=>r.active);
  const trace=async()=> (await readFile(path.join(root,'trace.jsonl'),'utf8').catch(()=> '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const until=async(fn,label)=>{for(let i=0;i<400&&!await fn()&&!exited;i++)await delay(100);assert.ok(await fn(),`${label}: ${output.slice(-1200)} ${root}`);};
  let runId;
  const events=()=>{const reader=readLedger(path.join(root,'station.db'));try{return reader.events(runId);}finally{reader.close();}};
  try {
    await until(async()=> (await trace()).filter(e=>e.type==='launch').length===4,'all four agents launched');
    await delay(700);runId=run().id;
    assert.ok(run().seats.every(s=>s.attention.completionVersion===0 && s.attention.watcher.state!=='error'));
    proc.write('\x1b`');await delay(150);proc.write('Brainstorm a name for Rellin.');await delay(150);proc.write('\r');
    await until(()=>run().seats.filter(s=>s.agent==='claude').every(s=>s.attention.watcher.state==='pending'&&s.attention.watcher.error?.includes('No native turn')),'delayed history stays uncertain');
    assert.equal(events().filter(e=>e.type==='table-ended').length,0,'observation delay does not discard the discussion');
    assert.equal((await trace()).filter(e=>e.type==='submit').length,4,'no retransmission while native evidence is delayed');
    await writeFile(path.join(root,'release-native'),'continue');
    await until(()=>events().some(e=>e.type==='table-ended'&&e.payload.reason==='completed'),'blank-seat table completes three rounds');
    const submissions=(await trace()).filter(e=>e.type==='submit');
    assert.deepEqual((await trace()).filter(e=>e.type==='error'),[],'fixture agents remain healthy');
    assert.equal(submissions.length,12,'no warm-up or duplicate requests');
    assert.ok(submissions.every(e=>e.text.includes('Station table request')));
    assert.equal(new Set(submissions.map(e=>e.id)).size,4);
    assert.equal(events().filter(e=>e.type==='table-answer').length,12);
    assert.equal(events().filter(e=>e.type==='table-response-match').length,12);
    const packets=events().filter(e=>e.type==='table-prompt'&&e.payload.requestFile);
    assert.equal(packets.length,6,'both Codex seats use files in every round');
    for(const {payload:p} of packets) {
      assert.equal(await readFile(p.requestFile,'utf8'),p.text,'full peer context is preserved');
      if(p.round>1) assert.ok(Buffer.byteLength(p.text)>11000,'exercise prompts beyond the reported failure size');
      assert.ok(submissions.some(e=>e.text===p.deliveredText),'native matching uses the delivered instruction');
      assert.ok((await trace()).some(e=>e.type==='request-read'&&e.file===p.requestFile&&e.body===p.text),'agent read its complete packet');
    }
    assert.ok(run().seats.every(s=>s.attention.completionVersion===3&&s.attention.watcher.state==='healthy'));
    assert.equal(events().filter(e=>e.type==='table-blocked').length,0);
    proc.write('\x11');await until(()=>exited,'quit');console.log('Blank four-seat table passed');
  } catch(error){console.error(root,error);process.exitCode=1;}
  finally{if(!exited)proc.kill();}
  process.exit(process.exitCode||0);
}
