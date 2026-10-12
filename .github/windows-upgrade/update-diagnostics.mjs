import { writeSync } from 'node:fs';

export const UPDATE_PHASES = Object.freeze({
  chooseNightly: 'choose nightly channel', checkNightly: 'check nightly channel',
  observeNightly: 'observe nightly channel status', validateNightly: 'validate nightly channel status',
  chooseTarget: 'choose target channel', checkTarget: 'check target update',
  observeTarget: 'observe exact target offer', validateTarget: 'validate exact target offer',
});
const phases = new Set(Object.values(UPDATE_PHASES));
export const isUpdatePhase = value => phases.has(value);
const states = new Set(['idle', 'checking', 'available', 'downloading', 'ready', 'error', 'up-to-date']);
const kinds = new Set(['gh-missing', 'gh-auth', 'no-access', 'network', 'cancelled', 'verify', 'install', 'failed']);
const messages = new Map([
  ['Nightly downloads aren’t responding. Search again later.', 'nightly-unresponsive'],
  ['Die Nightly-Downloads antworten nicht. Später erneut suchen.', 'nightly-unresponsive'],
  ['GitHub isn’t responding. Search again later.', 'github-unresponsive'],
  ['GitHub antwortet nicht. Später erneut suchen.', 'github-unresponsive'],
  ['Can’t connect to GitHub. Check your internet connection and search again.', 'github-connection'],
  ['Keine Verbindung zu GitHub. Internetverbindung prüfen und erneut suchen.', 'github-connection'],
  ['GitHub didn’t return a readable release list.', 'invalid-release-list'],
  ['GitHub hat keine lesbare Release-Liste geliefert.', 'invalid-release-list'],
  ['GitHub’s response is unexpectedly large.', 'response-too-large'],
  ['Die Antwort von GitHub ist unerwartet groß.', 'response-too-large'],
  ['The public update channel can’t be reached.', 'public-channel-unavailable'],
  ['Der öffentliche Update-Kanal ist nicht erreichbar.', 'public-channel-unavailable'],
  ['GitHub is limiting requests right now. Search again later.', 'github-rate-limit'],
  ['GitHub begrenzt gerade die Anfragen. Später erneut suchen.', 'github-rate-limit'],
  ['The updater did not offer the exact regular stable channel switch.', 'offer-mismatch'],
  ['The normal nightly channel check failed.', 'nightly-status-mismatch'],
  ['Choose nightly channel timed out.', 'settings-timeout'],
  ['Choose target channel timed out.', 'settings-timeout'],
  ['Settle nightly check timed out.', 'check-timeout'],
  ['Regular update check timed out.', 'check-timeout'],
  ['Nightly channel status timed out.', 'status-timeout'],
  ['Nightly channel status not observed.', 'status-timeout'],
  ['Exact target offer timed out.', 'status-timeout'],
  ['Exact target offer not observed.', 'status-timeout'],
  ['Target page, context or browser has been closed', 'bridge-closed'],
]);
const httpMessages = [
  [/^Nightly downloads are unavailable right now \(status ([1-5]\d{2})\)\. Search again later\.$/, 'nightly-unavailable'],
  [/^Die Nightly-Downloads sind gerade nicht erreichbar \(Status ([1-5]\d{2})\)\. Später erneut suchen\.$/, 'nightly-unavailable'],
  [/^GitHub responded with status ([1-5]\d{2})\. Search again later\.$/, 'github-http'],
  [/^GitHub antwortet mit Status ([1-5]\d{2})\. Später erneut suchen\.$/, 'github-http'],
];
function field(value, key) {
  try { return value?.[key]; } catch { return undefined; }
}
function enumValue(value, allowed) {
  return value === undefined ? 'missing' : allowed.has(value) ? value : 'other';
}
const booleanValue = value => value === undefined ? 'missing' : typeof value === 'boolean' ? value : 'other';

// Only fixed classifications and HTTP numbers leave this module. No Error serialization.
export function updateFailureObservation(error) {
  const kind = enumValue(field(error, 'kind'), kinds);
  const raw = typeof error === 'string' ? error : field(error, 'message');
  const result = { errorClass: error === undefined ? 'none' : 'unknown', kind, httpStatus: null };
  if (typeof raw !== 'string' || raw.length > 4096) return result;
  const text = raw.split(/\r?\n/, 1)[0].replace(/^(?:page\.evaluate: )?(?:Error: )?/, '');
  if (messages.has(text)) return { ...result, errorClass: messages.get(text) };
  for (const [pattern, errorClass] of httpMessages) {
    const match = pattern.exec(text);
    if (match) return { ...result, errorClass, httpStatus: Number(match[1]) };
  }
  return result;
}

export function updateStatusObservation(status, versions) {
  const version = value => value === undefined ? 'missing'
    : typeof value !== 'string' ? 'other'
    : value === field(versions, 'startVersion') ? 'start'
    : value === field(versions, 'targetVersion') ? 'target' : 'other';
  return {
    state: enumValue(field(status, 'state'), states),
    channel: enumValue(field(status, 'channel'), new Set(['stable', 'nightly'])),
    currentVersion: version(field(status, 'currentVersion')),
    version: version(field(status, 'version')),
    channelSwitch: booleanValue(field(status, 'channelSwitch')),
    supported: booleanValue(field(status, 'supported')),
    installMode: enumValue(field(status, 'installMode'), new Set(['restart', 'reveal'])),
    error: updateFailureObservation(field(status, 'error')),
  };
}

export async function reportUpdateFailure({ phase, error, lastStatus, readStatus, versions }, {
  emit = value => writeSync(2, `AYCODE_UPDATE_DIAGNOSTIC=${JSON.stringify(value)}\n`),
  timeoutMs = 3000,
} = {}) {
  const result = {
    phase: isUpdatePhase(phase) ? phase : 'other',
    failure: updateFailureObservation(error),
    lastStatus: updateStatusObservation(lastStatus, versions),
  };
  let timer;
  try {
    // One bounded read of the existing status; never trigger another check or change a feed.
    const observed = await Promise.race([
      Promise.resolve().then(readStatus).then(
        value => ({ observation: value && typeof value === 'object' ? 'observed' : 'invalid-result', value }),
        error => ({ observation: 'read-error', error }),
      ),
      new Promise(resolve => { timer = setTimeout(() => resolve({ observation: 'timeout' }), timeoutMs); }),
    ]);
    result.observation = observed.observation;
    if (observed.observation === 'observed') result.status = updateStatusObservation(observed.value, versions);
    if (observed.observation === 'read-error') result.readFailure = updateFailureObservation(observed.error);
  } finally { clearTimeout(timer); }
  try { emit(result); } catch { /* Observation cannot replace the original probe failure. */ }
  return result;
}
