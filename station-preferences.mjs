import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const home = () => process.env.RELLIN_HOME || process.env.STATION_HOME || path.join(os.homedir(), '.mrmak');
export function readPreferences(dir = home()) {
  try { const value=JSON.parse(readFileSync(path.join(dir,'station-ui.json'),'utf8'));
    return { ...(Number.isInteger(value.shelfWidth) && value.shelfWidth>=26 && value.shelfWidth<=1000 ? {shelfWidth:value.shelfWidth} : {}),
      ...(typeof value.cacheReminders === 'boolean' ? {cacheReminders:value.cacheReminders} : {}) };
  } catch { return {}; }
}
export function saveShelfWidth(shelfWidth, dir = home()) {
  if(!Number.isInteger(shelfWidth) || shelfWidth<26 || shelfWidth>1000)return;
  savePreferences({shelfWidth},dir);
}
export function saveCacheReminders(cacheReminders, dir = home()) {
  if(typeof cacheReminders !== 'boolean')return;
  savePreferences({cacheReminders},dir);
}
function savePreferences(patch,dir) {
  mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'station-ui.json'), temporary=`${file}.${process.pid}.tmp`;
  writeFileSync(temporary,JSON.stringify({...readPreferences(dir),...patch})+'\n');
  renameSync(temporary,file);
}
