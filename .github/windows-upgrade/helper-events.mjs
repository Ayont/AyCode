import { spawn } from 'node:child_process';
import { lstat, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';

const MAX_EVENTS = 32;
const STARTUP_MS = 45_000;
const LIFE_MS = 180_000;
const REASONS = new Set(['unsupported-platform', 'invalid-context', 'startup-timeout', 'observer-error', 'invalid-event', 'event-limit', 'output-limit', 'observer-exited']);
const STAGES = new Set(['assembly', 'construct', 'subscribe', 'start', 'queue']);
const uint32 = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;

/** Pure bounded correlation: missing/ambiguous events are not a successful helper exit. */
export function createHelperEventState(mainPid) {
  let ready = false, reason, failure, ended = false, ambiguous = false, count = 0;
  const starts = new Map(), stops = new Map();
  const fail = value => { reason ??= REASONS.has(value) ? value : 'observer-error'; };
  const accept = event => {
    if (reason || ended) return;
    if (++count > MAX_EVENTS) { fail('event-limit'); return; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) { fail('invalid-event'); return; }
    if (event.kind === 'ready' && Object.keys(event).length === 1 && !ready) { ready = true; return; }
    if (event.kind === 'failed') {
      if (Object.keys(event).length !== 3 || !Object.hasOwn(event, 'stage') || !Object.hasOwn(event, 'hresults') ||
          !STAGES.has(event.stage) || !Array.isArray(event.hresults) || event.hresults.length > 4 ||
          !Array.from(event.hresults).every(uint32)) { fail('invalid-event'); return; }
      failure = { stage: event.stage, hresults: [...event.hresults] };
      fail('observer-error'); return;
    }
    if (event.kind === 'done' && Object.keys(event).length === 1) { ended = true; return; }
    const keys = event.kind === 'start' ? ['kind', 'pid', 'parent', 'timeMs']
      : event.kind === 'stop' ? ['kind', 'pid', 'parent', 'timeMs', 'exitStatus'] : [];
    if (!keys.length || Object.keys(event).length !== keys.length || keys.some(key => !Object.hasOwn(event, key)) ||
        !uint32(event.pid) || event.pid === 0 || event.parent !== mainPid ||
        !Number.isSafeInteger(event.timeMs) || event.timeMs < 0 || event.timeMs > 1_844_674_407_370_955 ||
        (event.kind === 'stop' && !uint32(event.exitStatus))) { fail('invalid-event'); return; }
    const entries = event.kind === 'start' ? starts : stops;
    if (entries.size >= 8 && !entries.has(event.pid)) { fail('event-limit'); return; }
    const previous = entries.get(event.pid);
    if (previous && (previous.timeMs !== event.timeMs || previous.exitStatus !== event.exitStatus)) ambiguous = true;
    entries.set(event.pid, { timeMs: event.timeMs, ...(event.kind === 'stop' ? { exitStatus: event.exitStatus } : {}) });
    if (starts.size > 1) ambiguous = true;
    const start = starts.get(event.pid), stop = stops.get(event.pid);
    if (start && stop && stop.timeMs < start.timeMs) ambiguous = true;
  };
  const snapshot = () => {
    if (reason) return { state: 'failed', reason, ready, ...(failure ? { stage: failure.stage, hresults: [...failure.hresults] } : {}) };
    if (ambiguous) return { state: 'ambiguous', ready };
    const base = { ready, startCount: starts.size, stopCount: stops.size };
    const entry = starts.entries().next().value;
    const stop = entry && stops.get(entry[0]);
    if (ready && entry && stop && stops.size === 1)
      return { state: 'observed', ...base, exitStatus: stop.exitStatus, lifetimeMs: stop.timeMs - entry[1].timeMs };
    if (ended) return { state: 'unknown', ...base };
    return { state: !ready ? 'starting' : entry ? 'running' : 'waiting', ...base };
  };
  return { accept, snapshot, fail, finish: () => { ended = true; } };
}

// Event-arrival delivery can be reversed. Node correlates the two independently subscribed streams.
// No -Action runspace, permanent subscription, polling process table or audit policy change.
export const OBSERVER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$startWatcher = $null
$stopWatcher = $null
$stage = 'assembly'
function Emit($record) {
  [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
try {
  Add-Type -AssemblyName System.Management
  $stage = 'construct'
  $mainPid = [uint32]$env:AYCODE_OBSERVER_MAIN_PID
  if ($mainPid -eq 0) { throw 'invalid' }
  $startQuery = "SELECT ProcessID, ParentProcessID, ProcessName, TIME_CREATED FROM Win32_ProcessStartTrace WHERE ParentProcessID = $mainPid AND ProcessName = 'powershell.exe'"
  $stopQuery = "SELECT ProcessID, ParentProcessID, ProcessName, TIME_CREATED, ExitStatus FROM Win32_ProcessStopTrace WHERE ParentProcessID = $mainPid AND ProcessName = 'powershell.exe'"
  $startWatcher = New-Object System.Management.ManagementEventWatcher
  $stopWatcher = New-Object System.Management.ManagementEventWatcher
  $startWatcher.Scope = New-Object System.Management.ManagementScope('root\CIMV2')
  $stopWatcher.Scope = New-Object System.Management.ManagementScope('root\CIMV2')
  $startWatcher.Query = New-Object System.Management.WqlEventQuery($startQuery)
  $stopWatcher.Query = New-Object System.Management.WqlEventQuery($stopQuery)
  $stage = 'subscribe'
  $null = Register-ObjectEvent -InputObject $startWatcher -EventName EventArrived -SourceIdentifier 'aycode-helper-start'
  $null = Register-ObjectEvent -InputObject $stopWatcher -EventName EventArrived -SourceIdentifier 'aycode-helper-stop'
  $stage = 'start'
  $startWatcher.Start()
  $stopWatcher.Start()
  $stage = 'queue'
  Emit @{kind='ready'}
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $count = 0
  while ($clock.ElapsedMilliseconds -lt 180000 -and -not (Test-Path -LiteralPath $env:AYCODE_OBSERVER_STOP)) {
    $null = Wait-Event -Timeout 1
    foreach ($item in @(Get-Event | Where-Object { $_.SourceIdentifier -eq 'aycode-helper-start' -or $_.SourceIdentifier -eq 'aycode-helper-stop' })) {
      $count++
      if ($count -gt 32) { throw 'limit' }
      $event = $item.SourceEventArgs.NewEvent
      if ([uint32]$event.ParentProcessID -ne $mainPid -or [string]$event.ProcessName -ine 'powershell.exe') { throw 'identity' }
      $record = @{kind='start';pid=[uint32]$event.ProcessID;parent=[uint32]$event.ParentProcessID;timeMs=[long][decimal]::Truncate(([decimal][uint64]$event.TIME_CREATED / 10000))}
      if ($item.SourceIdentifier -eq 'aycode-helper-stop') { $record.kind='stop'; $record.exitStatus=[uint32]$event.ExitStatus }
      Emit $record
      Remove-Event -EventIdentifier $item.EventIdentifier
    }
  }
  Emit @{kind='done'}
} catch {
  $codes = @()
  $failure = $_.Exception
  for ($level = 0; $level -lt 4 -and $null -ne $failure; $level++) {
    try { $codes += [uint32]([int64]$failure.HResult -band [int64]4294967295) } catch {}
    try { $failure = $failure.InnerException } catch { break }
  }
  Emit @{kind='failed';stage=$stage;hresults=@($codes)}
} finally {
  foreach ($watcher in @($startWatcher, $stopWatcher)) {
    if ($null -ne $watcher) { try { $watcher.Stop(); $watcher.Dispose() } catch {} }
  }
  Unregister-Event -SourceIdentifier 'aycode-helper-start' -ErrorAction SilentlyContinue
  Unregister-Event -SourceIdentifier 'aycode-helper-stop' -ErrorAction SilentlyContinue
}
`;

function observerEnvironment(values) {
  const allowed = new Map(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].map(key => [key.toUpperCase(), key]));
  const result = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const name = allowed.get(key.toUpperCase());
    if (name && typeof value === 'string') result[name] = value;
  }
  return result;
}

/** Starts only a read-only observer. Call dispose even when snapshot reports failure. */
export async function startObserver(context) {
  const state = createHelperEventState(context?.realPid);
  let child, directory, disposed = false, lifetime, stopPromise;
  const dispose = () => stopPromise ??= (async () => {
    disposed = true;
    clearTimeout(lifetime);
    if (directory) { try { await writeFile(join(directory, 'stop'), '', { flag: 'wx' }); } catch {} }
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1_500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      // Only this directly spawned observer is terminated. Never kill a traced PID or process tree.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 1_000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    }
    state.finish();
    if (child && child.exitCode === null && child.signalCode === null) state.fail('observer-error');
    else if (directory) { try { await rm(directory, { recursive: true, force: true }); } catch {} }
  })();
  const handle = { snapshot: state.snapshot, dispose };
  if (process.platform !== 'win32') { state.fail('unsupported-platform'); return handle; }
  try {
    const environment = observerEnvironment(context?.cleanEnv);
    const expectedPS = win32.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!uint32(context?.realPid) || !context.realPid || !isAbsolute(context.syntheticRoot) ||
        typeof context.systemPS !== 'string' || context.systemPS.toLowerCase() !== expectedPS.toLowerCase()) throw new Error('invalid');
    const info = await lstat(context.syntheticRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid');
    directory = await mkdtemp(join(context.syntheticRoot, 'helper-observer-'));
    const script = join(directory, 'observe.ps1');
    await writeFile(script, '\uFEFF' + OBSERVER_SCRIPT, { flag: 'wx', mode: 0o600 });
    child = spawn(context.systemPS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      env: { ...environment, AYCODE_OBSERVER_MAIN_PID: String(context.realPid), AYCODE_OBSERVER_STOP: join(directory, 'stop') },
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let buffer = '', bytes = 0;
    child.stdout.setEncoding('utf8');
    const started = new Promise(resolve => {
      const timer = setTimeout(() => { state.fail('startup-timeout'); resolve(); }, STARTUP_MS);
      const settle = () => { clearTimeout(timer); resolve(); };
      child.once('error', () => { state.fail('observer-error'); settle(); });
      child.once('exit', () => { if (!disposed) state.fail('observer-exited'); settle(); });
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        if (bytes > 16_384 || buffer.length > 2_048) { state.fail('output-limit'); settle(); void dispose(); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
          try { state.accept(JSON.parse(line)); } catch { state.fail('invalid-event'); }
          if (state.snapshot().ready || state.snapshot().state === 'failed') settle();
        }
        if (state.snapshot().state === 'failed') void dispose();
      });
      child.stderr.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16_384) { state.fail('output-limit'); settle(); void dispose(); }
      });
    });
    lifetime = setTimeout(() => { state.finish(); void dispose(); }, LIFE_MS);
    await started;
    if (state.snapshot().state === 'failed') await dispose();
  } catch { state.fail('invalid-context'); await dispose(); }
  return handle;
}
