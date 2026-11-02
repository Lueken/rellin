import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readPreferences,saveShelfWidth} from '../station-preferences.mjs';
import {configureShelf,createShelfDrag,consoleLayout} from '../station-view.mjs';
test('released divider width survives reload without persisting window-size clamps',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'station-ui-'));
 configureShelf({...readPreferences(dir),onChange:width=>saveShelfWidth(width,dir)});
 const drag=createShelfDrag();drag({kind:'press',x:26,y:2},120,36);drag({kind:'release',x:52,y:2},120,36);
 assert.equal(readPreferences(dir).shelfWidth,52);
 configureShelf();configureShelf(readPreferences(dir));
 assert.equal(consoleLayout(120,36).shelf.width,52);
 assert.equal(consoleLayout(80,24).shelf.width,40);
 assert.equal(readPreferences(dir).shelfWidth,52);
 await writeFile(path.join(dir,'station-ui.json'),'bad data');assert.deepEqual(readPreferences(dir),{});
 configureShelf();
});
