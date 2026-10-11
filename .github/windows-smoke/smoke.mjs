import { _electron } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { inputs, sha256 } from './download.mjs';

const expected = inputs(process.env);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This check requires native Windows x64.');
const root = process.env.AYCODE_SMOKE_ROOT;
if (!root) throw new Error('Missing isolated workspace.');
const ps = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const taskkill = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app;
let installer;
let phase = 'verification';

async function deadline(promise, label, ms = 60_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(read, accept, label) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const value = await deadline(read(), label, Math.max(1, end - Date.now()));
    if (accept(value)) return value;
    await delay(250);
  }
  throw new Error(`${label} was not ready.`);
}
function kill(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try { execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000, windowsHide: true, env: cleanEnv }); } catch { /* already exited */ }
}
async function close() {
  if (!app) return;
  const current = app;
  app = undefined;
  try { await deadline(current.close(), 'Application shutdown', 20_000); }
  catch (error) { kill(current.process().pid); throw error; }
}
function powerShell(script, extra = {}) {
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], { env: { ...cleanEnv, ...extra }, encoding: 'utf8', timeout: 120_000, windowsHide: true });
}

async function start(executable, profile) {
  app = await _electron.launch({ executablePath: executable, env: { ...cleanEnv, AYCODE_USER_DATA: profile, AYCODE_MOBILE_PORT: '0' }, timeout: 60_000 });
  const page = await deadline(app.firstWindow(), 'First application window');
  await until(() => Promise.resolve(page.url()), (url) => url.startsWith('file://') && url.endsWith('/renderer/index.html'), 'Packaged renderer');
  await until(() => page.evaluate(() => Boolean(window.aycode)), Boolean, 'Application bridge');
  const boot = await until(() => page.evaluate(() => window.aycode.bootstrap()), (value) => value.bootstrapComplete && value.engine?.state === 'ready', 'Packaged engine');
  if (boot.appVersion !== expected.version) throw new Error('Running version differs from the signed candidate.');
  return { page, boot, pid: app.process().pid };
}
async function exercise(executable, profile, label) {
  phase = `${label}: start`;
  await mkdir(profile);
  const folder = join(root, `${label}-project`);
  await mkdir(folder);
  const first = await start(executable, profile);
  const project = await deadline(first.page.evaluate((directory) => window.aycode.addProject(directory), folder), 'Create temporary project');
  if (!project?.id) throw new Error('Temporary project was not created.');
  phase = `${label}: native terminal`;
  const terminal = await deadline(first.page.evaluate((id) => window.aycode.terminalOpen(id, { cols: 80, rows: 24, command: "Write-Output ('AYCODE' + '_PUBLIC_PTY_OK')" }), project.id), 'PowerShell terminal');
  if (!/powershell(?:\.exe)?$/i.test(terminal.shell)) throw new Error('The default terminal is not PowerShell.');
  await until(() => first.page.evaluate((id) => window.aycode.terminalScrollback(id), terminal.id), (output) => output.includes('AYCODE_PUBLIC_PTY_OK'), 'PowerShell output');
  await deadline(first.page.evaluate((id) => window.aycode.terminalClose(id), terminal.id), 'Close temporary terminal');
  phase = `${label}: close and restart`;
  await close();
  const second = await start(executable, profile);
  if (!Array.isArray(second.boot.projects) || !second.boot.projects.some((item) => item.id === project.id && item.path === folder)) throw new Error('The temporary project did not survive restart.');
  await close();
  return { version: expected.version, engine: true, powershellPty: true, restart: true, profilePersisted: true };
}

try {
  const verified = JSON.parse(await readFile(join(root, 'verified-candidate.json'), 'utf8'));
  for (const [key, value] of Object.entries(expected)) if (verified[key] !== value) throw new Error(`Candidate proof mismatch: ${key}`);
  const zip = `AyCode-${expected.version}-win-x64.zip`;
  const setup = `AyCode-Setup-${expected.version}-win-x64.exe`;
  for (const name of [zip, setup]) {
    if (sha256(await readFile(join(root, name))) !== verified.assets[name]) throw new Error('Candidate changed after signature verification.');
  }
  const unpacked = join(root, 'zip-app');
  phase = 'ZIP extraction';
  powerShell('Expand-Archive -LiteralPath $env:SMOKE_ZIP -DestinationPath $env:SMOKE_UNPACKED', { SMOKE_ZIP: join(root, zip), SMOKE_UNPACKED: unpacked });
  const zipped = await exercise(join(unpacked, 'AyCode.exe'), join(root, 'zip-profile'), 'zip');
  console.log('ZIP passed: version, engine, native PowerShell, restart and fixture persistence.');

  // NSIS /D must be the final, unquoted argument, including spaces in the destination.
  // Only signed publisher binaries run; no user-provided path becomes a command.
  phase = 'NSIS installation';
  const installed = join(root, 'NSIS installed app');
  const nsisProfile = join(root, 'nsis-profile');
  await mkdir(nsisProfile);
  installer = spawn(join(root, setup), ['/S', `/D=${installed}`], { env: { ...cleanEnv, AYCODE_USER_DATA: nsisProfile, AYCODE_MOBILE_PORT: '0' }, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
  const exit = await deadline(new Promise((resolve, reject) => { installer.once('error', reject); installer.once('exit', resolve); }), 'NSIS installer', 120_000);
  installer = undefined;
  if (exit !== 0) throw new Error('NSIS installation failed.');
  const executable = join(installed, 'AyCode.exe');
  await access(executable);
  // runAfterFinish may start exactly this fresh installation; close only that path.
  powerShell('Get-Process | Where-Object { $_.ProcessName -eq "AyCode" -and $_.Path -eq $env:SMOKE_INSTALLED_EXE } | Stop-Process -Force', { SMOKE_INSTALLED_EXE: executable });
  const nsis = await exercise(executable, join(root, 'installed-profile'), 'installed');
  const proof = { ...expected, workflowCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, platform: 'win32', arch: 'x64', assets: verified.assets, zipped, nsis, inAppUpdate: false, appShotCapture: false };
  await writeFile(join(root, 'windows-proof.json'), JSON.stringify(proof, null, 2));
  console.log(`AYCODE_WINDOWS_PROOF=${JSON.stringify(proof)}`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `Windows ZIP and NSIS passed for ${expected.version}.\n\nSource: ${expected.sourceCommit}; pipeline: ${expected.pipelineId}.\n\nBoth runs checked version, engine, native PowerShell and a new process with persisted fixture data. In-app upgrade and AppShot capture were not tested.\n`);
} catch (error) {
  console.error(`Windows package check failed at ${phase}: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (installer) kill(installer.pid);
  if (app) { try { await close(); } catch { process.exitCode = 1; } }
}
