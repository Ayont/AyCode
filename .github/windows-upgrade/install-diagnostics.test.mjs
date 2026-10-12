import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installFailureClass, observeInstallRequest, observeMainIdentity, reportInstallFailure,
} from './install-diagnostics.mjs';

const secret = 'TOKEN_SECRET https://private.invalid/path?token=SECRET C:\\private\\profile';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'aycode-install-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'local', 'AyCode-staging', 'updater', '7.4.6');
  const userData = join(root, 'user-data');
  await mkdir(staging, { recursive: true });
  await mkdir(join(userData, 'logs'), { recursive: true });
  return { root, staging, userData, executable: join(root, 'app', 'AyCode.exe'), pid: 123 };
}

function options(overrides = {}) {
  return {
    child: { pid: 123, exitCode: null, signalCode: null },
    signalZero: () => {},
    nativeRead: async () => ({ alive: true, executableMatches: true }),
    emit: () => {},
    ...overrides,
  };
}

test('request and deadline are observed separately with monotonic settlement timings', async () => {
  let time = 100, resolveRequest, rejectDeadline;
  const events = [];
  const request = new Promise(resolve => { resolveRequest = resolve; });
  const observer = observeInstallRequest(request, { now: () => time, emit: event => events.push(event) });
  assert.equal(observer.promise, request);
  assert.equal(observer.snapshot().request.state, 'pending');
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  assert.equal(observer.observeDeadline(deadline), deadline);
  time = 130;
  rejectDeadline(new Error('Install request timed out.'));
  await tick();
  assert.deepEqual(observer.snapshot().deadline, { state: 'rejected', settledAfterMs: 30, errorClass: 'request-timeout' });
  assert.equal(observer.snapshot().request.state, 'pending');
  time = 170;
  resolveRequest();
  await tick();
  assert.deepEqual(observer.snapshot().request, { state: 'resolved', settledAfterMs: 70 });
  assert.deepEqual(events.map(event => event.event), ['request-started', 'deadline-rejected', 'request-resolved']);
});

test('known rejection classification never serializes arbitrary error material', async () => {
  assert.equal(installFailureClass(new Error(secret)), 'unknown');
  assert.equal(installFailureClass({ get message() { throw new Error(secret); } }), 'unknown');
  const original = new Error(secret);
  const events = [];
  const rejected = Promise.reject(original);
  const observer = observeInstallRequest(rejected, { emit: event => events.push(event) });
  await assert.rejects(observer.promise, error => error === original);
  await tick();
  assert.equal(observer.snapshot().request.state, 'rejected');
  assert.equal(observer.snapshot().request.errorClass, 'unknown');
  assert.doesNotMatch(JSON.stringify(events), /TOKEN_SECRET|private|https|profile/);
});

test('exact shipped helper rejection strings survive the known Playwright prefix only', () => {
  const cases = [
    ['helper-ready-timeout', 'The update helper did not respond. AyCode stays open. Try again or install the current version from aycode.ai.'],
    ['helper-ready-timeout', 'Der Update-Helfer antwortet nicht. AyCode bleibt geöffnet. Versuche es erneut oder installiere die aktuelle Version von aycode.ai.'],
    ['helper-exited-before-ready', 'The update helper stopped before it was ready. AyCode stays open. Try again or install the current version from aycode.ai.'],
    ['helper-exited-before-ready', 'Der Update-Helfer wurde vorzeitig beendet. AyCode bleibt geöffnet. Versuche es erneut oder installiere die aktuelle Version von aycode.ai.'],
  ];
  for (const [kind, text] of cases) {
    assert.equal(installFailureClass(new Error(text)), kind);
    assert.equal(installFailureClass(new Error(`page.evaluate: Error: ${text}\n    at evaluate (<anonymous>:1:2)`)), kind);
    assert.equal(installFailureClass(new Error(`${secret} ${text}`)), 'unknown');
  }
  for (const prefix of ['The update helper couldn’t be started: ', 'Der Update-Helfer ließ sich nicht starten: '])
    assert.equal(installFailureClass(new Error(prefix + secret)), 'helper-spawn-failed');
});

test('main process identity remains an observation and discards all other returned data', async () => {
  assert.deepEqual(await observeMainIdentity(async () => ({ pidMatches: true, executableMatches: true, secret })),
    { state: 'observed', pidMatches: true, executableMatches: true });
  assert.deepEqual(await observeMainIdentity(async () => { throw new Error(secret); }), { state: 'read-error' });
  assert.deepEqual(await observeMainIdentity(async () => ({ pidMatches: secret, executableMatches: true })), { state: 'invalid-result' });
});

test('shipped preflight rejections map to fixed classes and discard interpolated values', () => {
  const cases = [
    ['not-ready', 'There’s no verified update ready.'],
    ['not-ready', 'Es liegt kein geprüftes Update bereit.'],
    ['development-mode', 'In development mode AyCode doesn’t replace itself. The verified version is ready to look at.'],
    ['development-mode', 'Im Entwicklungsmodus ersetzt sich AyCode nicht selbst. Die geprüfte Version liegt zum Ansehen bereit.'],
    ['target-not-writable', `AyCode isn’t allowed to replace itself in “${secret}”. Show the verified download in Explorer and unpack it by hand.`],
    ['target-not-writable', `AyCode darf sich in „${secret}“ nicht selbst ersetzen. Zeig den geprüften Download im Explorer und entpack ihn von Hand.`],
    ['staged-exe-missing', 'AyCode.exe is missing from the update.'],
    ['staged-exe-missing', 'Im Update fehlt AyCode.exe.'],
    ['staged-version-mismatch', `The update reports version ${secret} instead of 7.4.6.`],
    ['staged-version-mismatch', `Das Update meldet Version ${secret} statt 7.4.6.`],
    ['invalid-helper-path', 'Invalid path for the update.'],
    ['invalid-helper-path', 'Ungültiger Pfad für das Update.'],
    ['invalid-helper-pid', 'Invalid process ID for the update.'],
    ['invalid-helper-pid', 'Ungültige Prozess-ID für das Update.'],
  ];
  for (const [kind, message] of cases) {
    assert.equal(installFailureClass(new Error(message)), kind);
    assert.equal(installFailureClass(new Error(`page.evaluate: Error: ${message}\n    at evaluate (<anonymous>:1:2)`)), kind);
    assert.equal(installFailureClass(new Error(`${secret} ${message}`)), 'unknown');
  }
  assert.equal(installFailureClass(new Error('The update reports version nope')), 'unknown');
});

test('observer clock and sink failures never change request fulfillment or rejection', async () => {
  const fail = () => { throw new Error(secret); };
  const result = Promise.resolve(42);
  const fulfilled = observeInstallRequest(result, { now: fail, emit: fail });
  assert.equal(await fulfilled.promise, 42);
  const original = new Error('original');
  const rejected = observeInstallRequest(Promise.reject(original), { now: fail, emit: fail });
  await assert.rejects(rejected.promise, error => error === original);
  assert.doesNotThrow(() => rejected.snapshot());
});

test('missing readiness differs from an exact UTF-16 ready acknowledgement', async t => {
  const paths = await fixture(t);
  const reports = [];
  await reportInstallFailure(paths, options({ emit: report => reports.push(report) }));
  assert.equal(reports[0].files.ready.state, 'missing');
  await writeFile(join(paths.staging, 'helper.ready'), Buffer.from('\uFEFFready\r\n', 'utf16le'));
  await reportInstallFailure(paths, options({ emit: report => reports.push(report) }));
  assert.equal(reports[1].files.ready.state, 'ready');
  await writeFile(join(paths.staging, 'helper.ready'), `ready\n${secret}`);
  await reportInstallFailure(paths, options({ emit: report => reports.push(report) }));
  assert.equal(reports[2].files.ready.state, 'unrecognized');
  assert.doesNotMatch(JSON.stringify(reports), /TOKEN_SECRET|private\.invalid|C:\\/);
});

test('bounded tails emit fixed helper markers and counts without raw log contents', async t => {
  const paths = await fixture(t);
  const date = '2026-10-12 00:00:00 ';
  await writeFile(join(paths.staging, 'helper.log'), `${secret}\n${'x'.repeat(20_000)}\n` +
    date + 'waiting for AyCode (pid 123)\n' +
    date + 'AyCode is still running; nothing changed.\n' +
    date + 'Could not move the running app aside.\n' +
    date + 'relaunch failed: ' + secret + '\n' +
    date + secret + '; restoring the previous app.\n' +
    date + 'updated\n');
  await writeFile(join(paths.userData, 'logs', 'main.log'), `${secret}\n`);
  let report;
  await reportInstallFailure(paths, options({ emit: value => { report = value; } }));
  assert.equal(report.files.helper.truncated, true);
  assert.ok(report.files.helper.bytesRead <= 16_384);
  assert.deepEqual(report.files.helper.markers, {
    waiting: 1, stillRunning: 1, moveFailed: 1, relaunchFailed: 1, restoring: 1, updated: 1,
  });
  assert.equal(report.files.main.lineCount, 1);
  assert.doesNotMatch(JSON.stringify(report), /TOKEN_SECRET|private\.invalid|C:\\|waiting for|restoring the/);
});

test('native observer timeout is distinct from child-process exit and native liveness', async t => {
  const paths = await fixture(t);
  let report;
  await reportInstallFailure(paths, options({
    child: { pid: 123, exitCode: null, signalCode: null },
    nativeRead: async () => ({ state: 'timeout' }),
    emit: value => { report = value; },
  }));
  assert.deepEqual(report.child, { pidMatches: true, exitState: 'pending', signalState: 'unset' });
  assert.equal(report.native.signalZero, 'alive');
  assert.equal(report.native.identity.state, 'timeout');
  await reportInstallFailure(paths, options({
    child: { pid: 123, exitCode: 0, signalCode: null },
    signalZero: () => { const error = new Error(secret); error.code = 'ESRCH'; throw error; },
    nativeRead: async () => ({ alive: false, executableMatches: false }),
    emit: value => { report = value; },
  }));
  assert.equal(report.child.exitState, 'zero');
  assert.equal(report.native.signalZero, 'absent');
  assert.deepEqual(report.native.identity, { state: 'observed', alive: false, executableMatches: false });
});

test('hanging observations end without changing the install rejection or pending state', { timeout: 5_000 }, async t => {
  const paths = await fixture(t);
  const error = new Error('The update helper did not respond. AyCode stays open. Try again or install the current version from aycode.ai.');
  const observer = observeInstallRequest(Promise.reject(error), { emit: () => {} });
  await assert.rejects(observer.promise, value => value === error);
  const pending = observeInstallRequest(new Promise(() => {}), { emit: () => {} });
  let report;
  const before = performance.now();
  const [main] = await Promise.all([
    observeMainIdentity(() => new Promise(() => {})),
    reportInstallFailure(paths, options({ observer,
      nativeRead: () => new Promise(() => {}), emit: value => { report = value; },
    })),
  ]);
  assert.ok(performance.now() - before < 4_500);
  assert.equal(main.state, 'timeout');
  assert.equal(report.native.identity.state, 'timeout');
  assert.equal(report.install.request.errorClass, 'helper-ready-timeout');
  assert.equal(report.files.ready.state, 'missing');
  assert.equal(pending.snapshot().request.state, 'pending');
});

test('failed readers and malicious native output cannot leak text or replace original failure', async t => {
  const paths = await fixture(t);
  const original = new Error('original failure');
  let report;
  const events = [];
  try { throw original; } catch (error) {
    await reportInstallFailure(paths, options({
      child: { pid: 123, exitCode: secret, signalCode: secret },
      signalZero: () => { throw new Error(secret); },
      nativeRead: async () => ({ alive: secret, executableMatches: true, message: secret }),
      emit: value => { report = value; events.push(value); },
    }));
    assert.equal(error, original);
  }
  assert.equal(report.native.identity.state, 'invalid-result');
  assert.equal(report.child.exitState, 'unavailable');
  assert.equal(report.child.signalState, 'other');
  await assert.doesNotReject(reportInstallFailure(paths, options({ emit: () => { throw new Error(secret); } })));
  await assert.doesNotReject(reportInstallFailure(paths, options({ nativeRead: async () => { throw new Error(secret); } })));
  assert.doesNotMatch(JSON.stringify(events), /TOKEN_SECRET|private\.invalid|C:\\/);
});

test('forged observer fields are discarded instead of copied to diagnostics', async t => {
  const paths = await fixture(t);
  let report;
  await reportInstallFailure(paths, options({
    mainIdentity: { state: 'observed', pidMatches: true, executableMatches: true, secret },
    observer: { snapshot: () => ({ elapsedMs: 1, request: { state: 'rejected', settledAfterMs: 2, errorClass: secret }, deadline: { state: secret }, secret }) },
    emit: value => { report = value; },
  }));
  assert.doesNotMatch(JSON.stringify(report), /TOKEN_SECRET|private\.invalid|C:\\/);
});

test('diagnostics refuse paths outside the synthetic fixture', async t => {
  const paths = await fixture(t);
  let called = false, report;
  await reportInstallFailure({ ...paths, staging: tmpdir() }, options({
    nativeRead: async () => { called = true; }, emit: value => { report = value; },
  }));
  assert.equal(called, false);
  assert.equal(report.observerState, 'invalid-context');
});

test('run keeps the request and exit deadlines and collects diagnostics before cleanup', async () => {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(source, /deadline\(installObserver\.promise, 'Install request', 30_000\)/);
  assert.match(source, /previous\.process\(\)\.exitCode\),\s*value => value !== null,\s*'Original application exit',\s*60_000/);
  const report = source.indexOf('await reportInstallFailure(');
  assert.ok(report > source.indexOf('} catch (error) {', source.indexOf('const proof =')));
  assert.ok(report < source.indexOf('} finally {', report));
  assert.doesNotMatch(source.slice(source.indexOf("phase = 'real install"), report), /\bkill\(|\.quit\(/);
});
