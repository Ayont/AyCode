import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { cleanEnvironment } from './verify.mjs';

// Harmless fixtures only: no updater, app, downloaded program or installer runs.
export const CHILD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$root = $env:AYCODE_BOOTSTRAP_ROOT
$timings = [ordered]@{}
function Mark([string]$phase) {
  try {
    $timings[$phase] = @{elapsedMs=[long]$clock.ElapsedMilliseconds; fixtureElapsedMs=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$env:AYCODE_BOOTSTRAP_EPOCH)}
    [IO.File]::WriteAllText((Join-Path $root 'child.timing.json'), ($timings | ConvertTo-Json -Depth 3 -Compress))
  } catch {}
}
Mark 'entry'
$done = Join-Path $root 'child.done'
$state = 'failed'
$parent = $null
try {
  $parent = [Diagnostics.Process]::GetProcessById([int]$env:AYCODE_BOOTSTRAP_PARENT)
  $handle = $parent.Handle
  if ($handle -eq [IntPtr]::Zero -or $parent.HasExited) { throw 'parent-unavailable' }
  Mark 'parent-handle'
  [IO.File]::WriteAllText((Join-Path $root 'child.ready'), 'ready')
  Mark 'ready'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $committed = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ([IO.File]::Exists((Join-Path $root 'abort'))) { Mark 'abort-seen'; $state = 'aborted'; break }
    if (-not $committed -and [IO.File]::Exists((Join-Path $root 'commit'))) { $committed = $true; Mark 'commit-seen' }
    if ($parent.HasExited) {
      Mark 'parent-gone'
      if ($committed -and -not [IO.File]::Exists((Join-Path $root 'abort'))) {
        [IO.File]::WriteAllText((Join-Path $root 'action.marker'), 'parent-gone-after-commit')
        $state = 'completed'
      } else { $state = 'aborted' }
      break
    }
    Start-Sleep -Milliseconds 25
  }
  if ($state -eq 'failed') { $state = 'expired' }
} catch { $state = 'failed' }
finally {
  if ($null -ne $parent) { $parent.Dispose() }
  Mark 'done'
  [IO.File]::WriteAllText($done, $state)
}
`;

export const BOOTSTRAP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$root = $env:AYCODE_BOOTSTRAP_ROOT
$timings = [ordered]@{}
function Mark([string]$phase) {
  try {
    $timings[$phase] = @{elapsedMs=[long]$clock.ElapsedMilliseconds; fixtureElapsedMs=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$env:AYCODE_BOOTSTRAP_EPOCH)}
    [IO.File]::WriteAllText((Join-Path $root 'bootstrap.timing.json'), ($timings | ConvertTo-Json -Depth 3 -Compress))
  } catch {}
}
Mark 'entry'
$child = $null
try {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $env:AYCODE_BOOTSTRAP_PS
  $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $root 'own child.ps1') + '"'
  $info.WorkingDirectory = $root
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $child = [Diagnostics.Process]::Start($info)
  Mark 'process-start-return'
  $handle = $child.Handle
  if ($handle -eq [IntPtr]::Zero) { throw 'child-unavailable' }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (-not $child.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    if (-not $timings.Contains('child-ready') -and [IO.File]::Exists((Join-Path $root 'child.ready'))) { Mark 'child-ready' }
    if ([IO.File]::Exists((Join-Path $root 'abort'))) {
      if (-not $child.WaitForExit(3000)) { $child.Kill(); [void]$child.WaitForExit(1000) }
      break
    }
    Start-Sleep -Milliseconds 25
  }
} catch {
  [IO.File]::WriteAllText((Join-Path $root 'bootstrap.failed'), 'failed')
} finally {
  if ($null -ne $child) {
    try { if (-not $child.HasExited) { $child.Kill(); [void]$child.WaitForExit(1000) } } catch {}
    $child.Dispose()
  }
}
`;

export const PARENT_SCRIPT = String.raw`
const { spawn } = require('node:child_process');
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const root = process.env.AYCODE_BOOTSTRAP_ROOT;
const started = performance.now();
const timings = {};
const mark = async phase => {
  try {
    timings[phase] = { elapsedMs: Math.round(performance.now() - started), fixtureElapsedMs: Date.now() - Number(process.env.AYCODE_BOOTSTRAP_EPOCH) };
    await writeFile(join(root, 'parent.timing.json'), JSON.stringify(timings));
  } catch {}
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = async name => { try { return await readFile(join(root, name), 'utf8'); } catch { return ''; } };
(async () => {
  let failed = false;
  await mark('spawn');
  const child = spawn(process.env.AYCODE_BOOTSTRAP_PS,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(root, 'own bootstrap.ps1')],
    { cwd: root, env: { ...process.env, AYCODE_BOOTSTRAP_PARENT: String(process.pid) }, detached: false, windowsHide: true, stdio: 'ignore' });
  child.once('error', () => { failed = true; });
  const deadline = Date.now() + 75_000;
  while (!failed && Date.now() < deadline && await read('child.ready') !== 'ready' && await read('bootstrap.failed') !== 'failed') await pause(50);
  const ready = await read('child.ready') === 'ready';
  if (ready) await mark('ready');
  if (ready && process.env.AYCODE_BOOTSTRAP_CASE === 'commit') {
    await writeFile(join(root, 'commit'), 'commit');
    await mark('commit');
    await writeFile(join(root, 'parent.result'), 'committed');
  } else {
    await writeFile(join(root, 'abort'), 'abort');
    await mark('abort');
    const abortDeadline = Date.now() + 5_000;
    while (Date.now() < abortDeadline && await read('child.done') !== 'aborted') await pause(25);
    await writeFile(join(root, 'parent.result'), ready && await read('child.done') === 'aborted' ? 'aborted' : 'failed');
    if (!ready || await read('child.done') !== 'aborted') process.exitCode = 1;
  }
  // Let Node end naturally. Its non-detached direct child remains in libuv's
  // job; only the .NET-created grandchild may survive that job's closure.
  await mark('before-exit');
  child.unref();
})().catch(async () => {
  try { await writeFile(join(root, 'abort'), 'abort'); } catch {}
  process.exitCode = 1;
});
`;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const bom = script => `\uFEFF${script.trim().replace(/\r?\n/g, '\r\n')}\r\n`;
async function readFixed(root, name, limit = 128) {
  let handle;
  try {
    handle = await open(join(root, name), 'r');
    const bytes = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead < bytes.length ? bytes.subarray(0, bytesRead).toString('utf8') : '';
  } catch { return ''; } finally { await handle?.close().catch(() => {}); }
}
const TIMING_PHASES = {
  parent: ['spawn', 'ready', 'commit', 'abort', 'before-exit'],
  bootstrap: ['entry', 'process-start-return', 'child-ready'],
  child: ['entry', 'parent-handle', 'ready', 'commit-seen', 'abort-seen', 'parent-gone', 'done'],
};
function sanitizedTiming(kind, raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false };
    const allowed = TIMING_PHASES[kind];
    if (!allowed || Object.keys(parsed).some(key => !allowed.includes(key))) return { valid: false };
    const phases = {};
    for (const phase of allowed) {
      if (!Object.hasOwn(parsed, phase)) continue;
      const value = parsed[phase];
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'elapsedMs') || !Object.hasOwn(value, 'fixtureElapsedMs')
        || ![value.elapsedMs, value.fixtureElapsedMs].every(ms => Number.isSafeInteger(ms) && ms >= 0 && ms <= 110_000)) return { valid: false };
      phases[phase] = { elapsedMs: value.elapsedMs, fixtureElapsedMs: value.fixtureElapsedMs };
    }
    return { valid: true, phases };
  } catch { return { valid: false }; }
}
function absent(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}
async function stopOwnChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(); };
    const timer = setTimeout(finish, 1000);
    child.once('exit', finish);
    try { child.kill(); } catch { finish(); }
  });
}

async function experiment(t, mode) {
  const root = await mkdtemp(join(tmpdir(), "aycode bootstrap ä ' own "));
  let parent;
  t.after(async () => {
    await writeFile(join(root, 'abort'), 'abort').catch(() => {});
    await stopOwnChild(parent);
    // Never erase the abort signal while a self-expiring child may still need it.
    const end = Date.now() + 5000;
    while (Date.now() < end && !['completed', 'aborted', 'expired', 'failed'].includes(await readFixed(root, 'child.done'))) await pause(50);
    if (['completed', 'aborted', 'expired', 'failed'].includes(await readFixed(root, 'child.done'))) await rm(root, { recursive: true, force: true });
  });
  const env = cleanEnvironment(process.env, root);
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'AYCODE_USER_DATA']) await mkdir(env[key], { recursive: true });
  const systemPS = win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await writeFile(join(root, 'own child.ps1'), bom(CHILD_SCRIPT), { flag: 'wx' });
  await writeFile(join(root, 'own bootstrap.ps1'), bom(BOOTSTRAP_SCRIPT), { flag: 'wx' });
  await writeFile(join(root, 'own parent.cjs'), PARENT_SCRIPT, { flag: 'wx' });
  const started = performance.now();
  parent = spawn(process.execPath, [join(root, 'own parent.cjs')], {
    cwd: root, env: { ...env, AYCODE_BOOTSTRAP_ROOT: root, AYCODE_BOOTSTRAP_PS: systemPS, AYCODE_BOOTSTRAP_CASE: mode,
      AYCODE_BOOTSTRAP_EPOCH: String(Date.now()) },
    detached: false, windowsHide: true, stdio: 'ignore',
  });
  const exit = await new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish({ state: 'timeout', code: null }), 85_000);
    parent.once('error', () => finish({ state: 'spawn-error', code: null }));
    parent.once('exit', (code, signal) => finish({ state: signal === null ? 'exited' : 'signaled', code: Number.isSafeInteger(code) ? code : null }));
  });
  const parentExitElapsedMs = Math.round(performance.now() - started);
  const parentGone = Number.isSafeInteger(parent.pid) && absent(parent.pid);
  const end = Date.now() + 10_000;
  while (Date.now() < end && !['completed', 'aborted', 'expired', 'failed'].includes(await readFixed(root, 'child.done'))) await pause(25);
  if (mode === 'abort') await pause(2000);
  const result = { case: mode, parentState: exit.state, parentCode: exit.code, parentGone,
    ready: await readFixed(root, 'child.ready') === 'ready',
    parentHandshake: await readFixed(root, 'parent.result') === (mode === 'commit' ? 'committed' : 'aborted'),
    marker: await readFixed(root, 'action.marker') === 'parent-gone-after-commit',
    completed: await readFixed(root, 'child.done') === 'completed',
    aborted: await readFixed(root, 'child.done') === 'aborted', parentExitElapsedMs, elapsedMs: Math.round(performance.now() - started) };
  t.diagnostic(JSON.stringify(result));
  for (const kind of ['parent', 'bootstrap', 'child']) {
    t.diagnostic(JSON.stringify({ case: mode, process: kind, timing: sanitizedTiming(kind, await readFixed(root, `${kind}.timing.json`, 1024)) }));
  }
  assert.equal(result.parentState, 'exited', JSON.stringify(result));
  assert.equal(result.parentCode, 0, JSON.stringify(result));
  assert.equal(result.parentGone, true, JSON.stringify(result));
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.equal(result.parentHandshake, true, JSON.stringify(result));
  assert.equal(result.marker, mode === 'commit', JSON.stringify(result));
  assert.equal(result.completed, mode === 'commit', JSON.stringify(result));
  assert.equal(result.aborted, mode === 'abort', JSON.stringify(result));
}

test('phase diagnostics retain only fixed phases and bounded numeric elapsed values', () => {
  assert.deepEqual(sanitizedTiming('parent', '{"spawn":{"elapsedMs":0,"fixtureElapsedMs":2}}'), {
    valid: true, phases: { spawn: { elapsedMs: 0, fixtureElapsedMs: 2 } },
  });
  for (const raw of [
    '{"SECRET":{"elapsedMs":1,"fixtureElapsedMs":2}}',
    '{"spawn":{"elapsedMs":"SECRET","fixtureElapsedMs":2}}',
    '{"spawn":{"elapsedMs":1,"fixtureElapsedMs":2,"path":"SECRET"}}',
    '{"spawn":{"elapsedMs":-1,"fixtureElapsedMs":2}}',
    '{"spawn":{"elapsedMs":1,"fixtureElapsedMs":110001}}',
    '{"spawn":{"elapsedMs":1.5,"fixtureElapsedMs":2}}',
    '[]', 'null', 'SECRET',
  ]) assert.deepEqual(sanitizedTiming('parent', raw), { valid: false });
});

test('hidden .NET-launched harmless helper survives its synthetic Node parent natural exit', {
  skip: process.platform !== 'win32', timeout: 110_000,
}, t => experiment(t, 'commit'));

test('hidden .NET-launched harmless helper aborts without a later action marker', {
  skip: process.platform !== 'win32', timeout: 110_000,
}, t => experiment(t, 'abort'));
