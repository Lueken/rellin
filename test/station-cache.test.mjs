import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cacheObservation, cacheObserver, cacheLine, cacheWindow, cacheDetails, cacheReminder, resolveBilling, newCacheState, acceptCacheObservation } from '../station-cache.mjs';
import { readPreferences, saveShelfWidth, saveCacheReminders } from '../station-preferences.mjs';
import { tailNativeFile } from '../native-events.mjs';
import { seatCard, renderUsageModal } from '../station-view.mjs';
const start=Date.parse('2026-10-30T12:00:00Z');
const response=(usage,extra={})=>({type:'assistant',timestamp:new Date(start+5000).toISOString(),message:{id:'request1',model:'claude-opus',usage,content:[]},...extra});
const usage={cache_read_input_tokens:14000,cache_creation_input_tokens:1000,cache_creation:{ephemeral_5m_input_tokens:1000,ephemeral_1h_input_tokens:0}};
const seat=()=>({agent:'claude',seat:'claude',alive:true,cache:newCacheState({mode:'subscription',label:'max 5x'}),attention:{activity:'completed',watcher:{state:'healthy'}}});

test('billing resolves only allowlisted metadata; env wins and gateways stay unknown',()=>{
 const read=()=>({auth_mode:'chatgpt',OPENAI_API_KEY:'SECRET',tokens:{access_token:'SECRET'},claudeAiOauth:{subscriptionType:'max',rateLimitTier:'default_claude_max_5x',accessToken:'SECRET'}});
 assert.deepEqual(resolveBilling('codex',{}, {read}),{mode:'subscription',label:'ChatGPT plan'});
 assert.deepEqual(resolveBilling('claude',{}, {read,platform:'win32'}),{mode:'subscription',label:'max 5x'});
 assert.equal(resolveBilling('claude',{ANTHROPIC_API_KEY:'secret'},{read}).mode,'api');
 assert.equal(resolveBilling('codex',{OPENAI_API_KEY:'secret'},{read}).mode,'api');
 assert.equal(resolveBilling('claude',{ANTHROPIC_BASE_URL:'https://gateway',ANTHROPIC_API_KEY:'secret'},{read}).mode,'unknown');
 assert.equal(resolveBilling('claude',{}, {read,platform:'darwin'}).mode,'unknown');
 assert.equal(resolveBilling('codex',{}, {read:()=>({auth_mode:'new-mode',OPENAI_API_KEY:'secret'})}).mode,'unknown');
 assert.equal(resolveBilling('claude',{}, {read:()=>{throw Error('missing');}}).mode,'unknown');
 assert.ok(!JSON.stringify(resolveBilling('claude',{}, {read,platform:'win32'})).includes('SECRET'));
});

test('observed writes establish conservative windows; absent data never means zero',()=>{
 const o=cacheObservation(response(usage),'claude',start);
 assert.equal(o.read,14000);assert.equal(o.windowEndsAt,start+300000);
 assert.equal(cacheObservation(response(usage),'claude').windowEndsAt,null);
 assert.equal(cacheObservation(response({cache_read_input_tokens:0}),'claude').written,null);
 assert.equal(cacheObservation(response({}),'claude'),null);
 assert.equal(cacheObservation(response(usage,{isSidechain:true}),'claude',start),null);
 const long={...usage,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:1000}};
 assert.equal(cacheObservation(response(long),'claude',start).ttlSeconds,3600);
 const mixed={...usage,cache_creation:{ephemeral_5m_input_tokens:500,ephemeral_1h_input_tokens:500}};
 assert.equal(cacheObservation(response(mixed),'claude',start).ttlSeconds,300);
 assert.equal(cacheObservation(response({...usage,cache_creation:{ephemeral_5m_input_tokens:5,ephemeral_1h_input_tokens:0}}),'claude',start).windowEndsAt,null);
 const hit={type:'event_msg',timestamp:new Date(start).toISOString(),payload:{type:'token_count',info:{last_token_usage:{cached_input_tokens:12000},total_token_usage:{cached_input_tokens:40000}}}};
 const codex=cacheObservation(hit,'codex');assert.equal(codex.read,12000);assert.equal(codex.written,null);assert.equal(codex.windowEndsAt,null);assert.equal(codex.scope,'request');
 delete hit.payload.info.last_token_usage;assert.equal(cacheObservation(hit,'codex').scope,'session');
});

test('new observations replace old clocks; lifecycle and tracking uncertainty suppress countdowns',()=>{
 const s=seat();acceptCacheObservation(s.cache,cacheObservation(response(usage),'claude',start));
 assert.match(cacheLine(s,start+60000,44),/1k wrote.*~4m/);
 assert.match(cacheLine(s,start+400000,24),/write elapsed/);
 s.attention.watcher.state='error';assert.equal(cacheWindow(s,start+60000),null);
 s.attention.watcher.state='healthy';s.attention.activity='working';assert.equal(cacheWindow(s,start+60000),null);
 s.attention.activity='failed';assert.equal(cacheWindow(s,start+60000),null);
 s.attention.activity='completed';s.alive=false;assert.equal(cacheWindow(s,start+60000),null);s.alive=true;
 assert.equal(cacheWindow(s,start-1000),null);
 // A later read does not reveal its TTL or extend the old write estimate.
 acceptCacheObservation(s.cache,cacheObservation(response({cache_read_input_tokens:15000},{timestamp:new Date(start+60000).toISOString()}),'claude',start+55000));
 assert.equal(cacheWindow(s,start+60000),null);
 acceptCacheObservation(s.cache,null);assert.equal(cacheLine(s,start+60000),'cache unknown');
 assert.equal(cacheLine({...s,agent:'grok'}),'');
});

test('reminders are opt-in, once per write window, snoozable and cannot create turns',()=>{
 const s=seat();acceptCacheObservation(s.cache,cacheObservation(response(usage),'claude',start));
 const before=JSON.stringify(s.attention);
 assert.equal(cacheReminder(s,false,start+250000),null);
 assert.equal(cacheReminder(s,true,start+200000),null);
 s.cache.snoozeUntil=start+270000;assert.equal(cacheReminder(s,true,start+250000),null);
 assert.match(cacheReminder(s,true,start+280000),/cache write window/);
 assert.equal(cacheReminder(s,true,start+281000),null);
 assert.equal(cacheReminder(s,true,start+301000),null);
 assert.equal(JSON.stringify(s.attention),before);
});

test('native record observation does not add activity or completion events',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'cache-native-')), file=path.join(root,'history.jsonl'), observations=[],events=[];
 await writeFile(file,JSON.stringify({type:'user',timestamp:new Date(start).toISOString(),message:{content:'test'}})+'\n');
 const stop=tailNativeFile(file,'claude',e=>events.push(e),0,{interval:10,onHealth:()=>{},onRecord:cacheObserver('claude',o=>observations.push(o))});
 try {
  await stop.flush();await appendFile(file,JSON.stringify(response(usage))+'\n');await stop.flush();
  assert.equal(observations.length,1);assert.equal(observations[0].windowEndsAt,start+300000);
  assert.deepEqual(events.map(e=>e.kind),['turn-started','turn-started']); // user + streaming assistant, unchanged
 }finally{stop();}
});

test('reminder preference persists without overwriting the shelf width',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'cache-prefs-'));
 saveShelfWidth(42,dir);saveCacheReminders(true,dir);saveShelfWidth(46,dir);
 assert.deepEqual(readPreferences(dir),{shelfWidth:46,cacheReminders:true});
 saveCacheReminders(false,dir);assert.equal(readPreferences(dir).shelfWidth,46);
});

test('cache stays on row five and details distinguish counts, time and plan allowance',()=>{
 const s=seat();acceptCacheObservation(s.cache,cacheObservation(response(usage),'claude',start));
 const card=seatCard(s,0,{width:24,now:start+60000});assert.equal(card.length,5);assert.match(card[4],/^cache/);
 assert.ok(card[4].length<=24);
 const details=cacheDetails(s,start+60000).join('\n');assert.match(details,/max 5x/);assert.match(details,/not remaining plan/);assert.match(details,/reuse is not guaranteed/);
 const rendered=renderUsageModal({seats:[s],usage:[null],width:60,height:24,colorOf:()=>'',now:start+60000});
 assert.match(rendered,/r toggle/);assert.match(rendered,/s snooze focused seat 10m/);assert.match(rendered,/Usage unavailable/);
 assert.ok(!rendered.includes('$'));
});
