import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openStationScreen, withLoading } from '../station-screen.mjs';

const capture = () => ({rows:24,columns:80,chunks:[],write(text){this.chunks.push(text);}});
test('screen lifetime enters once and restores terminal modes exactly once', () => {
  const output=capture(), close=openStationScreen(output);
  assert.equal(output.chunks.length,1);
  assert.match(output.chunks[0],/\x1b\[\?1049h/);
  close(); close();
  assert.equal(output.chunks.length,2);
  assert.match(output.chunks[1],/\x1b\[\?1049l/);
  assert.match(output.chunks[1],/\x1b\[\?25h/);
});

test('fast transitions do not flash a loading indicator', async () => {
  const output=capture();
  assert.equal(await withLoading('Fast',async()=>42,{output,delayMs:50}),42);
  await delay(60);
  assert.deepEqual(output.chunks,[]);
});

test('slow loading updates only the footer and always stops, including errors', async () => {
  for (const failure of [false,true]) {
    const output=capture();
    const work=withLoading('Loading saved sessions…',async()=>{
      await delay(60);
      if(failure) throw new Error('fixture error');
      return 'loaded';
    },{output,delayMs:1,intervalMs:10});
    if(failure) await assert.rejects(work,/fixture error/); else assert.equal(await work,'loaded');
    assert.ok(output.chunks.length>=2);
    assert.match(output.chunks[0],/Loading saved sessions/);
    assert.ok(output.chunks.every(text=>text.includes('\x1b[24;1H') && !/1049|\x1b\[2J/.test(text)));
    const count=output.chunks.length;
    await delay(25);
    assert.equal(output.chunks.length,count,'no stale animation after transition');
  }
});
