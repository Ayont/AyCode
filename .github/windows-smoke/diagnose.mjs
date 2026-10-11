import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputs, sha256 } from './download.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Native Windows x64 required.');
const expected = inputs(process.env);
const root = process.env.AYCODE_SMOKE_ROOT;
if (!root || !win32.isAbsolute(root)) throw new Error('Missing isolated runner workspace.');
const verified = JSON.parse(await readFile(join(root, 'verified-candidate.json'), 'utf8'));
for (const [key, value] of Object.entries(expected)) if (verified[key] !== value) throw new Error('Candidate identity changed.');
const zip = `AyCode-${expected.version}-win-x64.zip`;
if (sha256(await readFile(join(root, zip))) !== verified.assets[zip]) throw new Error('Verified archive changed.');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
const ps = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const unpacked = join(root, 'diagnostic-zip-app');
execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DIAGNOSTIC_ZIP -DestinationPath $env:DIAGNOSTIC_DEST"], {
  env: { ...cleanEnv, DIAGNOSTIC_ZIP: join(root, zip), DIAGNOSTIC_DEST: unpacked }, encoding: 'utf8', timeout: 120_000, windowsHide: true,
});
const output = execFileSync(process.execPath, [fileURLToPath(new URL('./appshot-diagnosis.mjs', import.meta.url)), unpacked, join(root, 'visibility-evidence')], {
  env: cleanEnv, encoding: 'utf8', timeout: 150_000, maxBuffer: 2 * 1024 * 1024, windowsHide: false,
});
process.stdout.write(output);
