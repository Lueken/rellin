import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LEDGER_HOME } from './station-ledger.mjs';
import { shellCommand } from './platform.mjs';
import { within } from './util.mjs';

export const MAX_CLIPBOARD_IMAGE = 25 * 1024 * 1024;
export function clipboardCommand() {
  if (process.platform !== 'win32') throw new Error('Rellin clipboard-image capture currently supports Windows. Paste an image file path through your agent on this platform.');
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $image = [System.Windows.Forms.Clipboard]::GetImage()
  $stream = [System.IO.MemoryStream]::new()
  try {
    $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($stream.Length -gt ${MAX_CLIPBOARD_IMAGE}) { throw 'Clipboard image must be smaller than 25 MB.' }
    @{ type = 'image'; data = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress
  } finally { $stream.Dispose(); $image.Dispose() }
} elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
  $text = [System.Windows.Forms.Clipboard]::GetText()
  if ($text.Length -gt 64000) { throw 'Clipboard text must be shorter than 64000 characters.' }
  @{ type = 'text'; text = $text } | ConvertTo-Json -Compress
} else { @{ type = 'empty' } | ConvertTo-Json -Compress }`;
  return { file: shellCommand().file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}
export async function readClipboard({ run = promisify(execFile) } = {}) {
  const command = clipboardCommand();
  const { stdout } = await run(command.file, command.args, { windowsHide: true, timeout: 15000, maxBuffer: 36 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
}
export async function clipboardDraft({ read = readClipboard, dir = LEDGER_HOME } = {}) {
  const content = await read();
  if (content?.type === 'text') {
    if (typeof content.text !== 'string' || content.text.length > 64000) throw new Error('Clipboard text must be shorter than 64000 characters.');
    // Keep text as one draft; embedded paste terminators or Enter cannot submit it.
    const text = content.text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    return { text, image: null };
  }
  if (content?.type !== 'image') throw new Error('No image or text in the clipboard. Take a snip, then press Alt+V.');
  if (typeof content.data !== 'string' || content.data.length > Math.ceil(MAX_CLIPBOARD_IMAGE / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content.data)) throw new Error('Invalid clipboard image.');
  const bytes = Buffer.from(content.data, 'base64');
  if (bytes.length > MAX_CLIPBOARD_IMAGE || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Clipboard did not contain a PNG image smaller than 25 MB.');
  const folder = path.join(dir, 'attachments', new Date().toISOString().slice(0, 10));
  await mkdir(folder, { recursive: true });
  const actual = await realpath(folder);
  if (!within(await realpath(dir), actual)) throw new Error('Rellin attachments must stay inside its data directory.');
  const file = path.join(actual, `Screenshot-${randomUUID()}.png`);
  if (/["\x00-\x1f\x7f]/.test(file)) throw new Error('The attachment path cannot be inserted into an agent draft.');
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  return { text: `"${file}" `, image: file };
}

export const bracketedDraft = text => `\x1b[200~${text}\x1b[201~`;

export function clipboardWriteCommand() {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
[System.Windows.Forms.Clipboard]::SetText($text)`;
  return { file: shellCommand().file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}
function writeClipboardProcess(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Clipboard copy timed out.')); }, 10000);
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim() || 'Clipboard copy failed.')); });
    child.stdin.on('error', error => { clearTimeout(timer); reject(error); });
    // Clipboard contents are data on stdin, never executable command text.
    child.stdin.end(input);
  });
}
export async function copyText(text, { platform = process.platform, run = writeClipboardProcess, write = data => process.stdout.write(data) } = {}) {
  if (typeof text !== 'string' || !text.length) throw new Error('No text selected.');
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('Selection must be smaller than 1 MB.');
  const data = Buffer.from(text, 'utf8').toString('base64');
  if (platform === 'win32') {
    await run(clipboardWriteCommand(), data);
    return 'Copied to clipboard.';
  }
  write(`\x1b]52;c;${data}\x1b\\`);
  return 'Copy requested through your terminal clipboard.';
}
