import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveCommand, shellCommand } from './platform.mjs';
import { artifactTarget, loadFileSettings } from './station-artifacts.mjs';

const exec = promisify(execFile);
const quotePowerShell = value => "'" + value.replaceAll("'", "''") + "'";
export function powershellCommand(script) {
  return { file: shellCommand().file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], wait: true };
}
export function systemOpenCommand(target, platform = process.platform) {
  if (platform === 'win32') return powershellCommand(`$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${quotePowerShell(target)} | Out-Null`);
  return { file: platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', args: [target], wait: true };
}
export function browserExecutable(command) {
  // Read only the executable token from the registered handler. Never execute its command string.
  const match = /^\s*(?:"([^"]+\.exe)"|([^"\s]+\.exe))(?:\s|$)/i.exec(command);
  return match?.[1] || match?.[2] || null;
}
async function defaultBrowser(file) {
  const url = pathToFileURL(file).href;
  if (process.platform === 'win32') {
    const command = powershellCommand("$ErrorActionPreference = 'Stop'; $id = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice').ProgId; (Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $id + '\\shell\\open\\command')).GetValue('')");
    const { stdout } = await exec(command.file, command.args, { windowsHide: true, timeout: 5000, maxBuffer: 16384 });
    const executable = browserExecutable(stdout.trim());
    if (!executable || !(await stat(executable).catch(() => null))?.isFile()) throw new Error('Choose a browser executable in Files settings. The default browser could not be resolved.');
    return { file: executable, args: [url] };
  }
  if (process.platform === 'darwin') return { file: '/usr/bin/open', args: ['-a', 'Safari', url], wait: true };
  const { stdout } = await exec('xdg-settings', ['get', 'default-web-browser'], { timeout: 5000, maxBuffer: 16384 });
  const desktop = stdout.trim();
  if (!/^[\w.-]+\.desktop$/.test(desktop)) throw new Error('Choose a browser executable in Files settings.');
  return { file: 'gtk-launch', args: [desktop, url], wait: true };
}
async function configuredApp(executable, target) {
  if (!(await stat(executable).catch(() => null))?.isFile()) throw new Error('The configured application was not found. Update Files settings.');
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe') throw new Error('Choose the application .exe, not a shell script or shortcut.');
  return { file: executable, args: [target] };
}
export async function openingCommand(target) {
  if (target.route === 'obsidian' || target.route === 'system') return systemOpenCommand(target.target);
  if (target.executable) return configuredApp(target.executable, target.route === 'browser' ? pathToFileURL(target.target).href : target.target);
  if (target.route === 'browser') {
    try { return await defaultBrowser(target.target); }
    catch (error) { throw new Error(`Cannot find a browser. Set its executable in Files settings. ${error.message}`); }
  }
  if (process.platform === 'win32') return { file: path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'notepad.exe'), args: [target.target] };
  if (process.platform === 'darwin') return { file: '/usr/bin/open', args: ['-a', 'TextEdit', target.target], wait: true };
  const editor = ['gedit', 'kate', 'xed', 'mousepad', 'leafpad'].map(name => resolveCommand(name)).find(Boolean);
  if (!editor) throw new Error('Choose a text editor executable in Files settings to open source files and diffs.');
  return { file: editor, args: [target.target] };
}

async function launch(command) {
  if (command.wait) {
    await exec(command.file, command.args, { windowsHide: true, timeout: 10000, maxBuffer: 32768 });
    return;
  }
  await new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { shell: false, stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
// Injection keeps tests from opening real applications or touching real vaults.
export async function openArtifact(file, { settings, dir, command = openingCommand, run = launch } = {}) {
  const target = await artifactTarget(file, settings || await loadFileSettings(dir));
  try { await run(await command(target)); }
  catch (error) { throw new Error(`Could not open this file: ${error.message}`); }
  return { ...target, notice: `Open requested in ${target.route === 'system' ? 'the default app' : target.route}: ${path.basename(target.actual)}` };
}
