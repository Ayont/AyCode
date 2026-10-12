import { execFile } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

const OBSERVER_TIMEOUT_MS = 3_000;
const TAIL_BYTES = 16_384;
const REJECTIONS = new Map([
  ['The update helper did not respond. AyCode stays open. Try again or install the current version from aycode.ai.', 'helper-ready-timeout'],
  ['Der Update-Helfer antwortet nicht. AyCode bleibt geöffnet. Versuche es erneut oder installiere die aktuelle Version von aycode.ai.', 'helper-ready-timeout'],
  ['The update helper stopped before it was ready. AyCode stays open. Try again or install the current version from aycode.ai.', 'helper-exited-before-ready'],
  ['Der Update-Helfer wurde vorzeitig beendet. AyCode bleibt geöffnet. Versuche es erneut oder installiere die aktuelle Version von aycode.ai.', 'helper-exited-before-ready'],
  ['There’s no verified update ready.', 'not-ready'],
  ['Es liegt kein geprüftes Update bereit.', 'not-ready'],
  ['In development mode AyCode doesn’t replace itself. The verified version is ready to look at.', 'development-mode'],
  ['Im Entwicklungsmodus ersetzt sich AyCode nicht selbst. Die geprüfte Version liegt zum Ansehen bereit.', 'development-mode'],
  ['AyCode.exe is missing from the update.', 'staged-exe-missing'],
  ['Im Update fehlt AyCode.exe.', 'staged-exe-missing'],
  ['Invalid path for the update.', 'invalid-helper-path'],
  ['Ungültiger Pfad für das Update.', 'invalid-helper-path'],
  ['Invalid process ID for the update.', 'invalid-helper-pid'],
  ['Ungültige Prozess-ID für das Update.', 'invalid-helper-pid'],
]);
const ERROR_CLASSES = new Set([
  ...REJECTIONS.values(), 'helper-spawn-failed', 'request-timeout', 'original-exit-timeout', 'bridge-closed', 'unknown',
  'target-not-writable', 'staged-version-mismatch',
]);

// Only fixed classes leave this module. Never serialize Error objects or log text.
export function installFailureClass(error) {
  try {
    const message = error?.message;
    if (typeof message !== 'string') return 'unknown';
    // The preload returns only Error.message; Playwright may prefix it and append its own stack.
    const text = message.split(/\r?\n/, 1)[0].replace(/^(?:page\.evaluate: )?(?:Error: )?/, '');
    if (REJECTIONS.has(text)) return REJECTIONS.get(text);
    if (text.startsWith('The update helper couldn’t be started: ') || text.startsWith('Der Update-Helfer ließ sich nicht starten: '))
      return 'helper-spawn-failed';
    if (/^AyCode isn’t allowed to replace itself in “[^\r\n]+”\. Show the verified download in Explorer and unpack it by hand\.$/.test(text) ||
        /^AyCode darf sich in „[^\r\n]+“ nicht selbst ersetzen\. Zeig den geprüften Download im Explorer und entpack ihn von Hand\.$/.test(text))
      return 'target-not-writable';
    if (/^The update reports version [^\r\n]+ instead of [^\r\n]+\.$/.test(text) ||
        /^Das Update meldet Version [^\r\n]+ statt [^\r\n]+\.$/.test(text))
      return 'staged-version-mismatch';
    if (text === 'Install request timed out.') return 'request-timeout';
    if (text === 'Original application exit not observed.' || text === 'Original application exit timed out.')
      return 'original-exit-timeout';
    if (/^(?:page\.evaluate: )?Target page, context or browser has been closed$/.test(text))
      return 'bridge-closed';
  } catch { /* Hostile or unavailable error properties are not diagnostic evidence. */ }
  return 'unknown';
}

function output(value) {
  try { writeSync(2, `AYCODE_INSTALL_DIAGNOSTIC=${JSON.stringify(value)}\n`); } catch { /* stderr is observational. */ }
}

function emitSafely(emit, value) {
  try { emit(value); } catch { /* An observer must not affect installation or the original failure. */ }
}

export function observeInstallRequest(promise, { now = () => performance.now(), emit = output } = {}) {
  let origin, elapsed = 0;
  const clock = () => {
    try {
      const value = now();
      if (Number.isFinite(value)) {
        origin ??= value;
        elapsed = Math.max(elapsed, Math.max(0, Math.round(value - origin)));
      }
    } catch { /* Preserve the last observed monotonic value. */ }
    return elapsed;
  };
  const states = { request: { state: 'pending' }, deadline: { state: 'not-observed' } };
  clock();
  const watch = (observed, name) => {
    states[name] = { state: 'pending' };
    observed.then(
      () => settle(name, 'resolved'),
      error => settle(name, 'rejected', error),
    );
    return observed;
  };
  const settle = (name, state, error) => {
    const settledAfterMs = clock();
    const record = { state, settledAfterMs };
    if (state === 'rejected') record.errorClass = installFailureClass(error);
    states[name] = record;
    emitSafely(emit, { event: `${name}-${state}`, ...record });
  };
  emitSafely(emit, { event: 'request-started', elapsedMs: clock() });
  watch(promise, 'request');
  return {
    // Returning the original promise retains its exact result/error and existing deadline semantics.
    promise,
    observeDeadline: observed => watch(observed, 'deadline'),
    snapshot: () => ({ elapsedMs: clock(), request: { ...states.request }, deadline: { ...states.deadline } }),
  };
}

async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(() => ({ state: 'read-error' })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'timeout' }), OBSERVER_TIMEOUT_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function tail(file, maximum = TAIL_BYTES) {
  let handle;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return { state: 'not-regular' };
    handle = await open(file, 'r');
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, maximum));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - maximum));
    return { state: 'read', bytesRead, truncated: size > maximum, buffer: buffer.subarray(0, bytesRead) };
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'read-error' };
  } finally { try { await handle?.close(); } catch { /* Read-only best effort. */ } }
}

function readySummary(result) {
  if (result.state !== 'read') return { state: result.state };
  const encoding = result.buffer[0] === 0xff && result.buffer[1] === 0xfe ? 'utf16le' : 'utf8';
  const text = result.buffer.toString(encoding).replace(/^\uFEFF/, '').trim();
  return {
    state: !result.truncated && text === 'ready' ? 'ready' : 'unrecognized',
    bytesRead: result.bytesRead, truncated: result.truncated,
  };
}

function logSummary(result, helper) {
  if (result.state !== 'read') return { state: result.state };
  const lines = result.buffer.toString('utf8').split(/\r?\n/);
  if (result.truncated) lines.shift(); // A partial first line cannot establish a marker.
  const summary = {
    state: 'read', bytesRead: result.bytesRead, truncated: result.truncated,
    lineCount: lines.filter(Boolean).length,
  };
  if (helper) {
    summary.markers = { waiting: 0, stillRunning: 0, moveFailed: 0, relaunchFailed: 0, restoring: 0, updated: 0 };
    for (const line of lines) {
      const match = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (.*)$/.exec(line);
      if (!match) continue;
      const value = match[1];
      if (/^waiting for AyCode \(pid [1-9]\d*\)$/.test(value)) summary.markers.waiting++;
      if (value === 'AyCode is still running; nothing changed.') summary.markers.stillRunning++;
      if (value === 'Could not move the running app aside.') summary.markers.moveFailed++;
      if (value.startsWith('relaunch failed:')) summary.markers.relaunchFailed++;
      if (value.endsWith('; restoring the previous app.')) summary.markers.restoring++;
      if (value === 'updated') summary.markers.updated++;
    }
  } else {
    summary.knownErrors = lines.reduce((count, line) => count + Number(installFailureClass({ message: line }) !== 'unknown'), 0);
  }
  return summary;
}

function syntheticContext(context) {
  if (!isAbsolute(context.root) || !Number.isSafeInteger(context.pid) || context.pid < 1) return false;
  return ['staging', 'userData', 'executable'].every(key => {
    const part = relative(context.root, context[key]);
    return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  });
}

function nativeIdentity(context) {
  // No WMI enumeration: only the original fixture PID and its exact executable are read.
  const script = "$ErrorActionPreference='Stop'; " +
    "$p=Get-Process -Id ([int]$env:PROBE_PID) -ErrorAction SilentlyContinue; " +
    "$result=if ($p) { @{alive=$true;executableMatches=($p.Path -ieq $env:PROBE_EXE)} } " +
    "else { @{alive=$false;executableMatches=$false} }; $result | ConvertTo-Json -Compress";
  return new Promise(resolve => {
    execFile(context.powerShell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...context.environment, PROBE_PID: String(context.pid), PROBE_EXE: context.executable },
      timeout: OBSERVER_TIMEOUT_MS, maxBuffer: 1_024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => {
      if (error) return resolve({ state: error.killed ? 'timeout' : 'read-error' });
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve({ state: 'invalid-result' }); }
    });
  });
}

function identitySummary(value) {
  if (value?.state && ['timeout', 'read-error', 'invalid-result'].includes(value.state))
    return { state: value.state };
  if (typeof value?.alive !== 'boolean' || typeof value?.executableMatches !== 'boolean')
    return { state: 'invalid-result' };
  return { state: 'observed', alive: value.alive, executableMatches: value.executableMatches };
}

function mainIdentitySummary(value) {
  if (value?.state && ['timeout', 'read-error'].includes(value.state)) return { state: value.state };
  if (typeof value?.pidMatches !== 'boolean' || typeof value?.executableMatches !== 'boolean')
    return { state: 'invalid-result' };
  return { state: 'observed', pidMatches: value.pidMatches, executableMatches: value.executableMatches };
}

export async function observeMainIdentity(read) {
  return mainIdentitySummary(await bounded(read));
}

function installSummary(value) {
  const milliseconds = number => Number.isSafeInteger(number) && number >= 0 ? number : null;
  const state = value => {
    if (!['pending', 'resolved', 'rejected', 'not-observed'].includes(value?.state)) return { state: 'unavailable' };
    const result = { state: value.state };
    if (value.state === 'resolved' || value.state === 'rejected') result.settledAfterMs = milliseconds(value.settledAfterMs);
    if (value.state === 'rejected') result.errorClass = ERROR_CLASSES.has(value.errorClass) ? value.errorClass : 'unknown';
    return result;
  };
  return { elapsedMs: milliseconds(value?.elapsedMs), request: state(value?.request), deadline: state(value?.deadline) };
}

export async function reportInstallFailure(context, {
  observer, child, mainIdentity, emit = output, nativeRead = nativeIdentity,
  signalZero = pid => process.kill(pid, 0),
} = {}) {
  const started = performance.now();
  try {
    if (!syntheticContext(context)) {
      emitSafely(emit, { event: 'failure-snapshot', observerState: 'invalid-context' });
      return;
    }
    let alive;
    try { signalZero(context.pid); alive = 'alive'; }
    catch (error) { alive = error?.code === 'ESRCH' ? 'absent' : error?.code === 'EPERM' ? 'permission-denied' : 'read-error'; }
    const childState = {
      pidMatches: child?.pid === context.pid,
      exitState: child?.exitCode === null ? 'pending' : child?.exitCode === 0 ? 'zero' : Number.isInteger(child?.exitCode) ? 'nonzero' : 'unavailable',
      signalState: child?.signalCode === null ? 'unset' : ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(child?.signalCode) ? child.signalCode : 'other',
    };
    const request = observer?.snapshot();
    const [ready, helper, main, identity] = await Promise.all([
      bounded(() => tail(join(context.staging, 'helper.ready'), 512).then(readySummary)),
      bounded(() => tail(join(context.staging, 'helper.log')).then(value => logSummary(value, true))),
      bounded(() => tail(join(context.userData, 'logs', 'main.log')).then(value => logSummary(value, false))),
      bounded(() => nativeRead(context)),
    ]);
    emitSafely(emit, {
      event: 'failure-snapshot', observerState: 'collected',
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      ...(request ? { install: installSummary(request) } : {}),
      ...(mainIdentity ? { mainIdentity: mainIdentitySummary(mainIdentity) } : {}),
      child: childState, native: { signalZero: alive, identity: identitySummary(identity) },
      files: { ready, helper, main },
    });
  } catch {
    emitSafely(emit, { event: 'failure-snapshot', observerState: 'observer-error' });
  }
}
