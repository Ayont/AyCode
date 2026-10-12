// Public blackbox checks only. No application source or private service credentials.
import { createHash, verify } from 'node:crypto';
import { win32 } from 'node:path';

export const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlPWYoCb9ZF7jDSMFdEBDc1DLdwbISZRkch3EXIx0NhM=
-----END PUBLIC KEY-----`;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const cdns = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com'
]);
const exact = (pattern, value) =>
  typeof value === 'string' && value.trim() === value && pattern.test(value);

export function inputs(env) {
  const keys = [
    'proofKind',
    'stableVersion',
    'nightlyVersion',
    'stableSourceCommit',
    'nightlySourceCommit',
    'stableReleaseId',
    'stablePipelineId',
    'nightlyPipelineId',
    'stableManifestSha256',
    'nightlyManifestSha256'
  ];
  const values = Object.fromEntries(keys.map(key => [
    key,
    env['AYCODE_' + key.replace(/[A-Z]/g, c => '_' + c).toUpperCase()]
  ]));

  for (const key of ['stableReleaseId', 'stablePipelineId', 'nightlyPipelineId'])
    if (
      !exact(/^[1-9]\d{0,15}$/, values[key]) ||
      !Number.isSafeInteger(Number(values[key]))
    )
      throw new Error(`Invalid ${key}.`);

  if (!exact(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, values.stableVersion))
    throw new Error('Invalid stable version.');
  if (!exact(/^\d{1,4}\.\d{1,4}\.\d{1,4}-nightly\.\d{12}(?:\.[1-9]\d*)?$/, values.nightlyVersion))
    throw new Error('Invalid nightly version.');
  for (const key of ['stableSourceCommit', 'nightlySourceCommit'])
    if (!exact(/^[a-f0-9]{40}$/, values[key]))
      throw new Error(`Invalid ${key}.`);

  for (const key of ['stableManifestSha256', 'nightlyManifestSha256'])
    if (!exact(/^[a-f0-9]{64}$/, values[key]))
      throw new Error(`Invalid ${key}.`);

  checkPhase(values);
  return values;
}

function checkPhase(expected) {
  // These release-specific bounds keep an older-stable helper check from being
  // mistaken for the final candidate proof. Inputs never come from the feed.
  const targets = { 'pre-release-helper': '7.4.5', 'final-release': '7.4.6' };
  if (!Object.hasOwn(targets, expected.proofKind) ||
      expected.stableVersion !== targets[expected.proofKind] ||
      !expected.nightlyVersion?.startsWith('7.4.7-nightly.'))
    throw new Error('The proof phase does not match the exact release targets.');
  if (expected.proofKind === 'final-release' &&
      expected.stableSourceCommit !== expected.nightlySourceCommit)
    throw new Error('The final stable and nightly must contain the same candidate source.');
}

export function requiresStableUi(expected) {
  checkPhase(expected);
  return expected.proofKind === 'final-release';
}

export function checkRelease(release, expected, channel) {
  if (
    !['stable', 'nightly'].includes(channel) ||
    release?.draft !== false ||
    release.prerelease !== (channel === 'nightly') ||
    release.tag_name !== `v${expected[channel + 'Version']}` ||
    !Array.isArray(release.assets)
  )
    throw new Error('Release is not the exact published candidate.');
  if (channel === 'stable' && String(release.id) !== expected.stableReleaseId)
    throw new Error('Stable release ID mismatch.');
}

export function checkedRedirect(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !cdns.has(url.hostname)
  )
    throw new Error('Unapproved download redirect.');
  return url;
}

function downloadFailure(url, response) {
  const origin = url.hostname === 'api.github.com' ? 'github-api'
    : url.hostname === 'cloud.aycode.ai' ? 'nightly-gateway' : 'github-cdn';
  const details = [`HTTP ${response.status}`, `origin=${origin}`];
  for (const [name, maximum] of [
    ['x-ratelimit-remaining', 1_000_000_000],
    ['x-ratelimit-reset', 4_294_967_295],
    ['retry-after', 86_400],
  ]) {
    // Diagnostic header values are untrusted; never include free text or enumerate other headers.
    try {
      const value = response.headers.get(name);
      if (typeof value === 'string' && /^(?:0|[1-9]\d{0,9})$/.test(value) && Number(value) <= maximum)
        details.push(`${name}=${Number(value)}`);
    } catch { /* Missing diagnostics must not replace the original HTTP failure. */ }
  }
  return `Public download failed (${details.join('; ')}).`;
}

export async function request(value, fetcher = fetch) {
  let url = new URL(value);
  if (
    !/^https:\/\/api\.github\.com\/repos\/Ayont\/AyCode\/releases\/(?:[1-9]\d*|assets\/[1-9]\d*)$/.test(url.href) &&
    !/^https:\/\/cloud\.aycode\.ai\/v1\/releases\/nightly(?:\/assets\/[1-9]\d*)?$/.test(url.href)
  )
    throw new Error('Unapproved public API URL.');

  const signal = AbortSignal.timeout(5 * 60_000);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetcher(url, {
      headers: {
        Accept: url.pathname.includes('/assets/') ? 'application/octet-stream' : 'application/json',
        'User-Agent': 'AyCode-public-upgrade-probe'
      },
      credentials: 'omit',
      redirect: 'manual',
      signal
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(downloadFailure(url, response));
      }
      return response;
    }

    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location)
      throw new Error('Missing download redirect.');
    url = checkedRedirect(new URL(location, url));
  }
  throw new Error('Too many download redirects.');
}

export async function bytes(response, limit) {
  if (!response.body)
    throw new Error('Missing response body.');
  const chunks = [];
  let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > limit)
      throw new Error('Download size limit exceeded.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function signedManifest(sums, signature, expectedHash, publicKey = PUBLIC_KEY) {
  if (sha256(sums) !== expectedHash)
    throw new Error('Unexpected signed manifest identity.');
  const encoded = signature.toString('utf8').trim();
  if (
    !/^[A-Za-z0-9+/]{86}==$/.test(encoded) ||
    !verify(null, sums, publicKey, Buffer.from(encoded, 'base64'))
  )
    throw new Error('Invalid publisher signature.');

  const entries = new Map();
  const lines = sums.toString('utf8').trimEnd().split('\n');
  if (lines.length > 30)
    throw new Error('Manifest is too large.');
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,149})$/.exec(line);
    if (!match || entries.has(match[2]))
      throw new Error('Unsafe or duplicate manifest entry.');
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function checkSource(source, expected, channel) {
  if (
    !['stable', 'nightly'].includes(channel) ||
    source?.version !== expected[channel + 'Version'] ||
    source.commit !== expected[channel + 'SourceCommit'] ||
    String(source.pipeline) !== expected[channel + 'PipelineId']
  )
    throw new Error('Signed source identity mismatch.');
  if (channel === 'nightly' && source.channel !== 'nightly')
    throw new Error('Signed nightly channel mismatch.');
}

export function cleanEnvironment(env, root) {
  // No general environment forwarding: the application and its update helper see no CI credentials.
  const result = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)
  ));
  for (const [key, folder] of Object.entries({
    HOME: 'home',
    USERPROFILE: 'home',
    APPDATA: win32.join('home', 'AppData', 'Roaming'),
    LOCALAPPDATA: win32.join('home', 'AppData', 'Local'),
    TEMP: win32.join('home', 'AppData', 'Local', 'Temp'),
    TMP: win32.join('home', 'AppData', 'Local', 'Temp'),
    AYCODE_USER_DATA: 'profile'
  }))
    result[key] = win32.join(root, folder);
  result.AYCODE_MOBILE_PORT = '0';
  return result;
}

export function checkUpdate(status, expected, state) {
  if (
    status?.state !== state ||
    status.channel !== 'stable' ||
    status.currentVersion !== expected.nightlyVersion ||
    status.version !== expected.stableVersion ||
    status.channelSwitch !== true ||
    status.supported !== true
  )
    throw new Error('The updater did not offer the exact regular stable channel switch.');
  if (state === 'ready' && status.installMode !== 'restart')
    throw new Error('The updater cannot restart-install this candidate.');
}

export function checkHelperLog(text) {
  if (
    typeof text !== 'string' ||
    !/(?:^|\r?\n)\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} updated(?:\r?\n|$)/.test(text) ||
    /failed|restoring|could not|still running/i.test(text)
  )
    throw new Error('Update helper did not finish successfully.');
}
