import { _electron } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputs, sha256, needsAppShot } from './download.mjs';
import { cleanEnvironment } from './environment.mjs';
import { verifyWindowsShell } from './windows-ui.mjs';
import { verifyWindowsAccounts } from './windows-accounts.mjs';

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

async function prepareProfile(profile) {
  await mkdir(profile);
  const environment = cleanEnvironment(process.env, profile);
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'AYCODE_USER_DATA'])
    await mkdir(environment[key], { recursive: true });
  // .NET delegates to Windows Known Folders without creating missing folders.
  // Avoid compiling a helper just to query the OS, and fail on runner-profile fallback.
  const script = `$ErrorActionPreference = 'Stop'
$roaming = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
@{roamingExists=([bool]$roaming -and (Test-Path -LiteralPath $roaming -PathType Container)); localExists=([bool]$local -and (Test-Path -LiteralPath $local -PathType Container)); roamingMatches=($roaming -ieq $env:APPDATA); localMatches=($local -ieq $env:LOCALAPPDATA)} | ConvertTo-Json -Compress`;
  const folders = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: environment, encoding: 'utf8', timeout: 15_000, windowsHide: true,
  }).trim());
  console.log(`AYCODE_PROFILE_PREFLIGHT=${JSON.stringify(folders)}`);
  if (!folders.roamingExists || !folders.localExists ||
      !folders.roamingMatches || !folders.localMatches)
    throw new Error('Native Known Folders do not match the isolated application profile.');
  return environment;
}

async function startupDiagnostic(application, environment, stderr) {
  const exists = async name => access(join(environment.AYCODE_USER_DATA, name)).then(() => true, () => false);
  let mainLog = '';
  try {
    const handle = await open(join(environment.AYCODE_USER_DATA, 'logs', 'main.log'), 'r');
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 16 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      mainLog = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  } catch { /* A failure before logging is itself useful evidence. */ }
  const state = await deadline(application.evaluate(({ app, BrowserWindow }) => ({
    ready: app.isReady(), windows: BrowserWindow.getAllWindows().map(window => ({
      visible: window.isVisible(), minimized: window.isMinimized(), destroyed: window.isDestroyed(),
    })),
  })), 'Startup state diagnostic', 3_000).catch(() => ({ unavailable: true }));
  const sanitize = value => value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\b(Bearer\s+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[redacted]');
  console.error(`AYCODE_STARTUP_DIAGNOSTIC=${JSON.stringify({
    exitCode: application.process().exitCode, signalCode: application.process().signalCode, state,
    settingsFile: await exists('aycode.json'), mcpKeyFile: await exists('mcp-secrets.key'),
    mainLog: sanitize(mainLog), stderr: sanitize(stderr()),
  })}`);
}

async function start(executable, environment) {
  app = await _electron.launch({ executablePath: executable, env: environment, timeout: 60_000 });
  let stderr = '';
  app.process().stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
  let page;
  try { page = await deadline(app.firstWindow(), 'First application window'); }
  catch (error) { await startupDiagnostic(app, environment, () => stderr); throw error; }
  await until(() => Promise.resolve(page.url()), (url) => url.startsWith('file://') && url.endsWith('/renderer/index.html'), 'Packaged renderer');
  await until(() => page.evaluate(() => Boolean(window.aycode)), Boolean, 'Application bridge');
  const boot = await until(() => page.evaluate(() => window.aycode.bootstrap()), (value) => value.bootstrapComplete && value.engine?.state === 'ready', 'Packaged engine');
  if (boot.appVersion !== expected.version) throw new Error('Running version differs from the signed candidate.');
  if (boot.platform !== 'win32') throw new Error('The packaged application does not report Windows.');
  return { page, boot, pid: app.process().pid };
}
async function exercise(executable, profile, label) {
  phase = `${label}: start`;
  const environment = await prepareProfile(profile);
  const folder = join(root, `${label}-project`);
  await mkdir(folder);
  const first = await start(executable, environment);
  const project = await deadline(first.page.evaluate((directory) => window.aycode.addProject(directory), folder), 'Create temporary project');
  if (!project?.id) throw new Error('Temporary project was not created.');
  let nativeUi = false;
  let syntheticAccounts = false;
  // The baseline predates the current introduction and account implementation.
  if (needsAppShot(expected.version)) {
    phase = `${label}: native application navigation`;
    nativeUi = await verifyWindowsShell(app, first.page, project, { firstStart: true });
    phase = `${label}: synthetic Windows accounts`;
    syntheticAccounts = await verifyWindowsAccounts(app, first.page, profile);
  }
  phase = `${label}: native terminal`;
  const terminal = await deadline(first.page.evaluate((id) => window.aycode.terminalOpen(id, { cols: 80, rows: 24, command: "Write-Output ('AYCODE' + '_PUBLIC_PTY_OK')" }), project.id), 'PowerShell terminal');
  if (!/powershell(?:\.exe)?$/i.test(terminal.shell)) throw new Error('The default terminal is not PowerShell.');
  await until(() => first.page.evaluate((id) => window.aycode.terminalScrollback(id), terminal.id), (output) => output.includes('AYCODE_PUBLIC_PTY_OK'), 'PowerShell output');
  await deadline(first.page.evaluate((id) => window.aycode.terminalClose(id), terminal.id), 'Close temporary terminal');
  phase = `${label}: close and restart`;
  await close();
  const second = await start(executable, environment);
  if (!Array.isArray(second.boot.projects) || !second.boot.projects.some((item) => item.id === project.id && item.path === folder)) throw new Error('The temporary project did not survive restart.');
  await close();
  return { version: expected.version, platform: first.boot.platform, engine: true, powershellPty: true, restart: true, profilePersisted: true, nativeUi, syntheticAccounts };
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

  let appShotCapture = false;
  if (needsAppShot(expected.version)) {
    phase = 'packaged AppShot helper';
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('./appshot-probe.mjs', import.meta.url)), unpacked, join(root, 'appshot-evidence')], { env: cleanEnv, encoding: 'utf8', timeout: 75_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    const result = JSON.parse(output.trim());
    if (result.status !== 'passed') throw new Error('Packaged AppShot helper did not pass.');
    console.log(`AYCODE_APPSHOT_PROOF=${JSON.stringify(result)}`);
    appShotCapture = true;
  }

  // NSIS /D must be the final, unquoted argument, including spaces in the destination.
  // Only signed publisher binaries run; no user-provided path becomes a command.
  phase = 'NSIS installation';
  const installed = join(root, 'NSIS installed app');
  const nsisProfile = join(root, 'nsis-profile');
  const installerEnvironment = await prepareProfile(nsisProfile);
  installer = spawn(join(root, setup), ['/S', `/D=${installed}`], { env: installerEnvironment, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
  const exit = await deadline(new Promise((resolve, reject) => { installer.once('error', reject); installer.once('exit', resolve); }), 'NSIS installer', 120_000);
  installer = undefined;
  if (exit !== 0) throw new Error('NSIS installation failed.');
  const executable = join(installed, 'AyCode.exe');
  await access(executable);
  // runAfterFinish may start exactly this fresh installation; close only that path.
  powerShell('Get-Process | Where-Object { $_.ProcessName -eq "AyCode" -and $_.Path -eq $env:SMOKE_INSTALLED_EXE } | Stop-Process -Force', { SMOKE_INSTALLED_EXE: executable });
  const nsis = await exercise(executable, join(root, 'installed-profile'), 'installed');
  const proof = { ...expected, workflowCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, platform: 'win32', arch: 'x64', assets: verified.assets, zipped, nsis, inAppUpdate: false, appShotCapture };
  await writeFile(join(root, 'windows-proof.json'), JSON.stringify(proof, null, 2));
  console.log(`AYCODE_WINDOWS_PROOF=${JSON.stringify(proof)}`);
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `Windows ZIP and NSIS passed for ${expected.version}.\n\nSource: ${expected.sourceCommit}; pipeline: ${expected.pipelineId}.\n\nBoth runs checked version, Windows platform, engine, native PowerShell and a new process with persisted fixture data. ${zipped.nativeUi && nsis.nativeUi ? 'Both installations also passed first-start/navigation/menu/draft checks and synthetic Claude/Codex account isolation and cancellation.' : 'The old baseline does not include current UI/account checks.'} ${appShotCapture ? 'The shipped AppShot helper captured only a synthetic foreground window and rejected wrong/owner PIDs.' : 'AppShot is not part of this pre-7.4.6 baseline.'} In-app upgrade and Electron AppShot hotkey/composer integration were not tested.\n`);
} catch (error) {
  console.error(`Windows package check failed at ${phase}: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (installer) kill(installer.pid);
  if (app) { try { await close(); } catch { process.exitCode = 1; } }
}
