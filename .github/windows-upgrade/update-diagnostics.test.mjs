import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UPDATE_PHASES, isUpdatePhase, updateStatusObservation, updateFailureObservation, reportUpdateFailure } from './update-diagnostics.mjs';

const versions = { startVersion: '7.4.6', targetVersion: '7.4.7-nightly.202610112047.227' };
const secret = 'TOKEN_SECRET https://private.invalid/path?token=SECRET C:\\private\\profile';
const offered = { state: 'available', channel: 'nightly', currentVersion: versions.startVersion,
  version: versions.targetVersion, supported: true };

test('status diagnostics retain only fixed states, version labels and contract flags', () => {
 assert.deepEqual(updateStatusObservation(offered, versions), {
  state: 'available', channel: 'nightly', currentVersion: 'start', version: 'target',
  channelSwitch: 'missing', supported: true, installMode: 'missing',
  error: { errorClass: 'none', kind: 'missing', httpStatus: null }
 });
 const observed = updateStatusObservation({ ...offered, state: secret, channel: secret,
  currentVersion: secret, version: secret, channelSwitch: secret, supported: secret,
  installMode: secret, error: secret, notes: secret, url: secret, progress: { received: secret } }, versions);
 assert.equal(observed.state, 'other');
 assert.equal(observed.channel, 'other');
 assert.equal(observed.currentVersion, 'other');
 assert.equal(observed.version, 'other');
 assert.equal(observed.channelSwitch, 'other');
 assert.equal(observed.supported, 'other');
 assert.equal(observed.installMode, 'other');
 assert.equal(observed.error.errorClass, 'unknown');
 assert.doesNotMatch(JSON.stringify(observed), /TOKEN_SECRET|private|https|profile|notes|progress/);
 for (const flag of [true, false, undefined, null, 0, 'false']) {
  assert.equal(updateStatusObservation({ ...offered, channelSwitch: flag }, versions).channelSwitch,
   flag === undefined ? 'missing' : typeof flag === 'boolean' ? flag : 'other');
 }
});

test('existing public-feed EN/DE errors expose only exact classes and bounded HTTP statuses', () => {
 const cases = [
  ['nightly-unavailable', 'Nightly downloads are unavailable right now (status 503). Search again later.', 503],
  ['nightly-unavailable', 'Die Nightly-Downloads sind gerade nicht erreichbar (Status 403). Später erneut suchen.', 403],
  ['github-http', 'GitHub responded with status 502. Search again later.', 502],
  ['github-http', 'GitHub antwortet mit Status 404. Später erneut suchen.', 404],
  ['nightly-unresponsive', 'Nightly downloads aren’t responding. Search again later.', null],
  ['nightly-unresponsive', 'Die Nightly-Downloads antworten nicht. Später erneut suchen.', null],
  ['invalid-release-list', 'GitHub didn’t return a readable release list.', null],
  ['invalid-release-list', 'GitHub hat keine lesbare Release-Liste geliefert.', null],
  ['offer-mismatch', 'The updater did not offer the exact regular stable channel switch.', null],
 ];
 for (const [errorClass, message, httpStatus] of cases) {
  assert.deepEqual(updateFailureObservation({ kind: 'network', message }), { errorClass, kind: 'network', httpStatus });
  assert.equal(updateFailureObservation(new Error(`page.evaluate: Error: ${message}\n    at fixture`)).errorClass, errorClass);
  assert.equal(updateFailureObservation(new Error(`${secret} ${message}`)).errorClass, 'unknown');
 }
 for (const status of ['099', '600', '1000', '503 SECRET', '-1'])
  assert.equal(updateFailureObservation(new Error(`Nightly downloads are unavailable right now (status ${status}). Search again later.`)).errorClass, 'unknown');
 assert.deepEqual(updateFailureObservation({ message: secret, kind: secret, status: secret, cause: secret }),
  { errorClass: 'unknown', kind: 'other', httpStatus: null });
});

test('diagnosis identifies each API phase without unfiltered errors or changing the returned status', async () => {
 const phases = Object.values(UPDATE_PHASES);
 assert.equal(new Set(phases).size, phases.length);
 for (const phase of phases) {
  assert.equal(isUpdatePhase(phase), true);
  const emitted = [];
  const result = await reportUpdateFailure({ phase, error: new Error(secret), lastStatus: offered,
   readStatus: async () => offered, versions }, { emit: value => emitted.push(value) });
  assert.equal(result.phase, phase);
  assert.equal(result.observation, 'observed');
  assert.equal(result.status.channelSwitch, 'missing');
  assert.equal(result.lastStatus.version, 'target');
  assert.deepEqual(emitted, [result]);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SECRET|private|https|profile/);
 }
 assert.equal(isUpdatePhase(secret), false);
 const run = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
 for (const [name, operation] of [['chooseTarget', 'updateSettings'], ['checkTarget', 'checkForUpdates'],
  ['observeTarget', 'updateStatus'], ['validateTarget', 'checkUpdate']]) {
  const start = run.indexOf(`phase = UPDATE_PHASES.${name};`);
  assert.ok(start !== -1, `missing ${name} diagnostic phase`);
  const next = run.indexOf('phase = ', start + 8);
  assert.ok(run.slice(start, next === -1 ? undefined : next).includes(operation), `${name} must precede its API operation`);
 }
 assert.match(run, /await reportUpdateFailure\(/);
});

test('failed, malformed or stuck read-only observations never replace the original failure', async () => {
 const hostile = new Proxy({}, { get() { throw new Error(secret); } });
 assert.doesNotThrow(() => updateStatusObservation(hostile, hostile));
 assert.deepEqual(updateFailureObservation(hostile), { errorClass: 'unknown', kind: 'missing', httpStatus: null });
 for (const [readStatus, observation] of [
  [async () => { throw new Error(secret); }, 'read-error'],
  [async () => null, 'invalid-result'],
  [() => new Promise(() => {}), 'timeout'],
 ]) {
  const result = await reportUpdateFailure({ phase: secret, error: hostile,
   lastStatus: hostile, readStatus, versions }, { timeoutMs: 5, emit: () => { throw new Error(secret); } });
  assert.equal(result.phase, 'other');
  assert.equal(result.observation, observation);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SECRET|private|https|profile/);
 }
});
