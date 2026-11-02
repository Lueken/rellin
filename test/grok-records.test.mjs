import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import { nativeRecordProblem,nativeActivity,tailNativeFile } from '../native-events.mjs';
import { finalAssistantText } from '../station-turns.mjs';
import { conversationMessages } from '../station-conversation.mjs';
import { correlatedResponse } from '../station-coordination.mjs';
const block=text=>[{type:'text',text}];
test('Grok structured startup instructions are metadata, not work or unread answers',async()=>{
 const records=[{type:'system',content:'instructions'},{type:'user',content:block('project instructions'),synthetic_reason:'fixture-bootstrap'}];
 for(const record of records){assert.equal(nativeRecordProblem(record,'grok'),null);assert.equal(nativeActivity(record,'grok'),null);}
 assert.deepEqual(conversationMessages(records,'grok').messages,[]);
 const dir=await mkdtemp(path.join(os.tmpdir(),'grok-blocks-')),file=path.join(dir,'history.jsonl'),events=[],health=[];
 await writeFile(file,records.map(JSON.stringify).join('\n')+'\n');
 const stop=tailNativeFile(file,'grok',event=>events.push(event),0,{onHealth:state=>health.push(state),interval:10});
 try {
   await stop.flush(); assert.equal(health.at(-1).state,'pending'); assert.equal(events.length,0);
   await appendFile(file,JSON.stringify({type:'user',content:block('hello'),prompt_index:0})+'\n');await stop.flush();
   assert.equal(events.at(-1).kind,'turn-started');assert.equal(health.at(-1).state,'healthy');
   await appendFile(file,JSON.stringify({type:'assistant',content:block('hello back')})+'\n');await stop.flush();
   assert.equal(events.at(-1).kind,'turn-completed');
 } finally {stop();}
});
test('Grok block text works consistently for reader, final answer and exact table matching',()=>{
 const records=[{type:'user',content:block('question')},{type:'assistant',content:null,tool_calls:[{id:'t',type:'function',function:{name:'read',arguments:'{}'}}]},{type:'tool',content:'result'},{type:'assistant',content:block('answer')}];
 records.forEach(record=>assert.equal(nativeRecordProblem(record,'grok'),null));
 assert.equal(nativeActivity(records[1],'grok').kind,'turn-started');
 assert.equal(finalAssistantText(records,'grok'),'answer');
 assert.deepEqual(conversationMessages(records,'grok').messages.map(m=>m.text),['question','answer']);
 assert.equal(correlatedResponse(records,'grok',{text:'question'}).text,'answer');
 assert.equal(nativeRecordProblem({type:'user',content:[{type:'future',text:'not supported'}]},'grok'),'Unsupported Grok message format');
});
