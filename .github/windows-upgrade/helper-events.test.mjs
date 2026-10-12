import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createHelperEventState, startObserver, OBSERVER_SCRIPT } from './helper-events.mjs';
import { cleanEnvironment } from './verify.mjs';

const start = (pid = 456, timeMs = 1000) => ({ kind: 'start', pid, parent: 123, timeMs });
const stop = (pid = 456, timeMs = 1088, exitStatus = 37) => ({ kind: 'stop', pid, parent: 123, timeMs, exitStatus });
const ready = state => state.accept({ kind: 'ready' });

test('only a ready observer with a correlated start and stop yields an exit status', () => {
  const state = createHelperEventState(123);
  assert.equal(state.snapshot().state, 'starting');
  ready(state);
  assert.equal(state.snapshot().state, 'waiting');
  state.accept(start());
  assert.equal(state.snapshot().state, 'running');
  assert.equal(state.snapshot().exitStatus, undefined);
  state.accept(stop());
  assert.deepEqual(state.snapshot(), { state: 'observed', ready: true, startCount: 1, stopCount: 1, exitStatus: 37, lifetimeMs: 88 });
});

test('stop arriving before start is bounded and correlated by PID and event time', () => {
  const state = createHelperEventState(123); ready(state);
  state.accept(stop());
  assert.equal(state.snapshot().state, 'waiting');
  state.accept(start());
  assert.equal(state.snapshot().exitStatus, 37);
  const invalid = createHelperEventState(123); ready(invalid);
  invalid.accept(stop(456, 999)); invalid.accept(start());
  assert.equal(invalid.snapshot().state, 'ambiguous');
  assert.equal(invalid.snapshot().exitStatus, undefined);
});

test('foreign parents, multiple helpers and PID reuse never create false successful evidence', () => {
  const foreign = createHelperEventState(123); ready(foreign);
  foreign.accept({ ...start(), parent: 124 });
  assert.equal(foreign.snapshot().state, 'failed');
  const multiple = createHelperEventState(123); ready(multiple);
  multiple.accept(start()); multiple.accept(stop()); multiple.accept(start(457));
  assert.equal(multiple.snapshot().state, 'ambiguous');
  assert.equal(multiple.snapshot().exitStatus, undefined);
  const reused = createHelperEventState(123); ready(reused);
  reused.accept(start()); reused.accept(start(456, 2000));
  assert.equal(reused.snapshot().state, 'ambiguous');
});

test('invalid fields, arbitrary errors and event overflow produce fixed failures only', () => {
  for (const event of [
    { kind: 'start', pid: 0, parent: 123, timeMs: 1 },
    { ...stop(), exitStatus: -1 },
    { ...stop(), exitStatus: 2 ** 32 },
    { ...start(), timeMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...start(), path: 'SECRET C:\\private' },
    { kind: 'failed', reason: 'SECRET https://private.invalid' },
  ]) {
    const state = createHelperEventState(123); ready(state); state.accept(event);
    assert.equal(state.snapshot().state, 'failed');
    assert.doesNotMatch(JSON.stringify(state.snapshot()), /SECRET|private|https|path/);
  }
  const state = createHelperEventState(123); ready(state);
  for (let pid = 500; pid < 520; pid++) state.accept(stop(pid));
  assert.equal(state.snapshot().state, 'failed');
  assert.equal(state.snapshot().exitStatus, undefined);
});

test('observer setup failures expose only a fixed stage and up to four uint32 HRESULTs', () => {
  for (const stage of ['assembly', 'construct', 'subscribe', 'start', 'queue']) {
    const state = createHelperEventState(123);
    state.accept({ kind: 'failed', stage, hresults: [2147749911, 2147942405, 0, 4294967295] });
    assert.deepEqual(state.snapshot(), { state: 'failed', reason: 'observer-error', ready: false,
      stage, hresults: [2147749911, 2147942405, 0, 4294967295] });
  }
  const state = createHelperEventState(123);
  const event = { kind: 'failed', stage: 'start', hresults: [2147749911] };
  state.accept(event); event.hresults.push(1);
  state.snapshot().hresults.push(2);
  assert.deepEqual(state.snapshot().hresults, [2147749911]);
});

test('failed-event schema rejects arbitrary text, extra fields and unbounded HRESULT chains', () => {
  for (const patch of [
    { stage: 'SECRET https://private.invalid' }, { message: 'SECRET' }, { type: 'SECRET' },
    { hresults: ['SECRET'] }, { hresults: [-1] }, { hresults: [2 ** 32] },
    { hresults: [1.1] }, { hresults: [0, 0, 0, 0, 0] }, { hresults: null },
  ]) {
    const state = createHelperEventState(123);
    state.accept({ kind: 'failed', stage: 'start', hresults: [], ...patch });
    assert.deepEqual(state.snapshot(), { state: 'failed', reason: 'invalid-event', ready: false });
    assert.doesNotMatch(JSON.stringify(state.snapshot()), /SECRET|private|https/);
  }
});

test('a lost observer or missing pair is never treated as exit zero', () => {
  const state = createHelperEventState(123); ready(state); state.accept(start());
  state.fail('SECRET');
  assert.deepEqual(state.snapshot(), { state: 'failed', reason: 'observer-error', ready: true });
  const stopped = createHelperEventState(123); ready(stopped); stopped.finish();
  assert.equal(stopped.snapshot().state, 'unknown');
  assert.equal(stopped.snapshot().exitStatus, undefined);
});

test('both WMI subscriptions are filtered before the readiness handshake', () => {
  assert.match(OBSERVER_SCRIPT, /SELECT \* FROM Win32_ProcessStartTrace WHERE ParentProcessID = \$mainPid AND ProcessName = 'powershell\.exe'/);
  assert.match(OBSERVER_SCRIPT, /SELECT \* FROM Win32_ProcessStopTrace WHERE ParentProcessID = \$mainPid AND ProcessName = 'powershell\.exe'/);
  assert.ok(OBSERVER_SCRIPT.indexOf('$startWatcher.Start()') < OBSERVER_SCRIPT.indexOf("kind='ready'"));
  assert.ok(OBSERVER_SCRIPT.indexOf('$stopWatcher.Start()') < OBSERVER_SCRIPT.indexOf("kind='ready'"));
  assert.doesNotMatch(OBSERVER_SCRIPT, /CommandLine|Set-Audit|auditpol|Stop-Process|taskkill|\-Action/);
});

test('non-Windows fails closed without spawning or touching another platform', { skip: process.platform === 'win32' }, async () => {
  const observer = await startObserver({});
  assert.deepEqual(observer.snapshot(), { state: 'failed', reason: 'unsupported-platform', ready: false });
  await observer.dispose();
});

async function nativeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aycode-helper-event-test-'));
  const fixture = { root, children: [] };
  t.after(async () => {
    const { child, observer } = fixture;
    await Promise.all([...new Set([...fixture.children, child].filter(Boolean))].map(stopOwnedChild));
    await observer?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  fixture.env = cleanEnvironment(process.env, root);
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'AYCODE_USER_DATA']) await mkdir(fixture.env[key], { recursive: true });
  fixture.systemPS = win32.join(fixture.env.SystemRoot || fixture.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fixture;
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.off('exit', finish); resolve(); };
    const timer = setTimeout(finish, 1_000);
    child.once('exit', finish);
    // Only the ChildProcess created by this fixture is eligible for cleanup.
    try { child.kill(); } catch { finish(); }
  });
}

async function ownedExitProbe(fixture) {
  const script = join(fixture.root, 'owned-exit-probe.ps1');
  await writeFile(script, '\uFEFFexit 37\r\n', { flag: 'wx' });
  const child = fixture.child = spawn(fixture.systemPS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
    env: fixture.env, detached: true, stdio: 'ignore', windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned native probe timed out.')); }, 45_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Owned native probe failed to start.')); });
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });
}

const LAUNCH_CASES = [
  { name: 'baseline', detached: true, windowsHide: true, hiddenStyle: true, pipes: false },
  { name: 'attached', detached: false, windowsHide: true, hiddenStyle: true, pipes: false },
  { name: 'visible-startup', detached: true, windowsHide: false, hiddenStyle: true, pipes: false },
  { name: 'no-window-style', detached: true, windowsHide: true, hiddenStyle: false, pipes: false },
  { name: 'piped', detached: true, windowsHide: true, hiddenStyle: true, pipes: true },
  { name: 'visible-no-window-style', detached: true, windowsHide: false, hiddenStyle: false, pipes: false },
];
const PROBE_MARKER = 'aycode-owned-helper-ran';
const MARKER_SCRIPT = '\uFEFF$ErrorActionPreference = "Stop"\r\n[IO.File]::WriteAllText($env:AYCODE_HELPER_PROBE_MARKER, "aycode-owned-helper-ran")\r\nexit 37\r\n';

async function launchCase(fixture, variant) {
  const script = join(fixture.root, `${variant.name}.ps1`);
  const marker = join(fixture.root, `${variant.name}.marker`);
  await writeFile(script, MARKER_SCRIPT, { flag: 'wx' });
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (variant.hiddenStyle) args.push('-WindowStyle', 'Hidden');
  args.push('-File', script);
  const started = performance.now();
  let stdoutBytes = 0; let stderrBytes = 0;
  const child = spawn(fixture.systemPS, args, {
    env: { ...fixture.env, AYCODE_HELPER_PROBE_MARKER: marker }, cwd: fixture.root,
    detached: variant.detached, windowsHide: variant.windowsHide,
    stdio: variant.pipes ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  fixture.children.push(child);
  // Count a bounded amount without retaining or emitting arbitrary PowerShell text.
  child.stdout?.on('data', chunk => { stdoutBytes = Math.min(16_385, stdoutBytes + chunk.length); });
  child.stderr?.on('data', chunk => { stderrBytes = Math.min(16_385, stderrBytes + chunk.length); });
  const result = await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(value);
    };
    const timer = setTimeout(() => finish({ state: 'timeout', code: null, signal: null }), 10_000);
    child.once('error', () => finish({ state: 'spawn-error', code: null, signal: null }));
    child.once('exit', (code, signal) => finish({ state: 'exited', code: Number.isSafeInteger(code) ? code : null,
      signal: signal === null ? null : ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(signal) ? signal : 'other' }));
  });
  const elapsedMs = Math.round(performance.now() - started);
  if (result.state === 'timeout') await stopOwnedChild(child);
  const hasMarker = async () => {
    let handle;
    try {
      handle = await open(marker, 'r');
      const bytes = Buffer.alloc(PROBE_MARKER.length + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return bytesRead === PROBE_MARKER.length && bytes.subarray(0, bytesRead).toString('utf8') === PROBE_MARKER;
    } catch { return false; } finally { await handle?.close().catch(() => {}); }
  };
  const markerAtExit = await hasMarker();
  // A launcher may exit before an indirect child evaluates -File. Observe only
  // this fixture's marker for two seconds; do not inspect or terminate other PIDs.
  let markerAfterGrace = markerAtExit;
  const graceEnd = performance.now() + 2_000;
  while (!markerAfterGrace && performance.now() < graceEnd) {
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, graceEnd - performance.now()))));
    markerAfterGrace = await hasMarker();
  }
  const classify = bytes => bytes === 0 ? 'empty' : bytes > 16_384 ? 'overflow' : 'nonempty';
  return { case: variant.name, ...result, markerAtExit, markerAfterGrace, elapsedMs,
    stdout: variant.pipes ? classify(stdoutBytes) : 'not-captured',
    stderr: variant.pipes ? classify(stderrBytes) : 'not-captured' };
}

test('owned BOM PowerShell launch matrix preserves the required product baseline independently of WMI', {
  skip: process.platform !== 'win32', timeout: 110_000,
}, async t => {
  const fixture = await nativeFixture(t);
  const observations = [];
  for (const variant of LAUNCH_CASES) {
    const result = await launchCase(fixture, variant);
    observations.push(result);
    t.diagnostic(JSON.stringify(result));
  }
  const baseline = observations[0];
  assert.equal(baseline.state, 'exited', JSON.stringify(baseline));
  assert.equal(baseline.code, 37, JSON.stringify(baseline));
  assert.equal(baseline.markerAtExit, true, JSON.stringify(baseline));
});

test('native WMI observes the exit status of an owned short-lived PowerShell child', {
  skip: process.platform !== 'win32', timeout: 110_000,
}, async t => {
  const fixture = await nativeFixture(t);
  const observer = fixture.observer = await startObserver({ realPid: process.pid, systemPS: fixture.systemPS, cleanEnv: fixture.env, syntheticRoot: fixture.root });
  const initial = observer.snapshot();
  assert.equal(initial.ready, true, JSON.stringify(initial));
  assert.equal(initial.state, 'waiting', JSON.stringify(initial));
  const code = await ownedExitProbe(fixture);
  assert.equal(code, 37);
  const end = Date.now() + 10_000;
  while (Date.now() < end && observer.snapshot().state !== 'observed') await new Promise(resolve => setTimeout(resolve, 100));
  const result = observer.snapshot();
  assert.equal(result.state, 'observed', JSON.stringify(result));
  assert.equal(result.exitStatus, code, JSON.stringify(result));
  assert.ok(result.lifetimeMs >= 0, JSON.stringify(result));
});
