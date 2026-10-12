import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  assert.match(OBSERVER_SCRIPT, /Win32_ProcessStartTrace WHERE ParentProcessID = \$mainPid AND ProcessName = 'powershell\.exe'/);
  assert.match(OBSERVER_SCRIPT, /Win32_ProcessStopTrace WHERE ParentProcessID = \$mainPid AND ProcessName = 'powershell\.exe'/);
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
  const fixture = { root };
  t.after(async () => {
    const { child, observer } = fixture;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await observer?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  fixture.env = cleanEnvironment(process.env, root);
  for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'AYCODE_USER_DATA']) await mkdir(fixture.env[key], { recursive: true });
  fixture.systemPS = win32.join(fixture.env.SystemRoot || fixture.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fixture;
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

test('owned BOM PowerShell child starts with the product launch mode independently of WMI', {
  skip: process.platform !== 'win32', timeout: 55_000,
}, async t => {
  const fixture = await nativeFixture(t);
  assert.equal(await ownedExitProbe(fixture), 37, 'Owned native probe returned an unexpected exit code.');
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
