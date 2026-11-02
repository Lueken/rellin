import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
test('Codex model/permissions menus hold and recover the same table without replay or restarts',{timeout:110000},async()=>{
 const file=fileURLToPath(new URL('./fixtures/codex-menu-lifecycle.mjs',import.meta.url));
 const {stdout}=await promisify(execFile)(process.execPath,[file],{windowsHide:true,timeout:105000});
 assert.match(stdout,/Codex menu lifecycle passed/);
});
