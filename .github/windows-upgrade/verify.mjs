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
  const targets = { 'pre-release-helper': '7.4.5', 'final-release': '7.4.6', 'review-updater': '7.4.6', 'review-updater-nsis': '7.4.6' };
  if (!Object.hasOwn(targets, expected.proofKind) ||
      expected.stableVersion !== targets[expected.proofKind] ||
      !expected.nightlyVersion?.startsWith('7.4.7-nightly.'))
    throw new Error('The proof phase does not match the exact release targets.');
  if (expected.proofKind === 'final-release' &&
      expected.stableSourceCommit !== expected.nightlySourceCommit)
    throw new Error('The final stable and nightly must contain the same candidate source.');
  if (['review-updater', 'review-updater-nsis'].includes(expected.proofKind) &&
      expected.stableSourceCommit === expected.nightlySourceCommit)
    throw new Error('The updater review must identify the corrected source separately from the published target.');
}

export function upgradeRoute(expected) {
  checkPhase(expected);
  const review = ['review-updater', 'review-updater-nsis'].includes(expected.proofKind);
  // "stable" is the versioned input slot for the private review payload only in
  // this explicit phase. It never changes or certifies the published stable.
  return { start: review ? 'stable' : 'nightly', target: review ? 'nightly' : 'stable', channelSwitch: !review, review };
}

export function installationMode(expected) {
  checkPhase(expected);
  return expected.proofKind === 'review-updater-nsis' ? 'nsis' : 'zip';
}

export function packageNames(expected, channel) {
  if (!['stable', 'nightly'].includes(channel)) throw new Error('Invalid package channel.');
  const names = [`AyCode-${expected[channel + 'Version']}-win-x64.zip`];
  if (installationMode(expected) === 'nsis' && channel === 'stable')
    names.push(`AyCode-Setup-${expected.stableVersion}-win-x64.exe`);
  return names;
}

export function releaseAsset(release, name) {
  const matches = release?.assets?.filter(asset => asset.name === name);
  const asset = matches?.[0];
  if (matches?.length !== 1 || !Number.isSafeInteger(asset?.id) || asset.id < 1 ||
      !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 1024 ** 3 ||
      !exact(/^sha256:[a-f0-9]{64}$/, asset.digest))
    throw new Error('Missing, duplicate or invalid release asset.');
  return asset;
}

export function signedAssetHash(asset, name, manifest) {
  releaseAsset({ assets: [asset] }, name);
  const hash = manifest.get(name);
  if (!exact(/^[a-f0-9]{64}$/, hash) || asset.digest !== `sha256:${hash}`)
    throw new Error('Package lacks exact publisher signature.');
  return hash;
}

export function checkAssetBytes(asset, size, hash) {
  if (size !== asset.size || `sha256:${hash}` !== asset.digest)
    throw new Error('Package hash/size mismatch.');
}

export function checkNsisHost(env, root) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'Ayont/AyCode' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main' ||
      env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Windows' ||
      !['win25', 'win25-vs2026'].includes(env.ImageOS) ||
      !exact(/^[1-9]\d*$/, env.GITHUB_RUN_ID) || !exact(/^[1-9]\d*$/, env.GITHUB_RUN_ATTEMPT) ||
      !exact(/^[a-z]:[\\/].+/i, env.RUNNER_TEMP) || typeof root !== 'string' ||
      win32.normalize(root).toLowerCase() !== win32.join(env.RUNNER_TEMP,
        `aycode-review-upgrade-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`).toLowerCase())
    throw new Error('NSIS requires the isolated disposable Windows 2025 review workflow.');
}

const nsisFiles = ['Uninstall AyCode.exe', 'uninstallerIcon.ico'];
// electron-builder UUIDv5: appId me.ayont.aycode, namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3.
export const NSIS_PRODUCT_GUID = '2dcd7861-0419-52a7-9e05-c1e642848ea2';

export function checkNsisFreshRegistration(value) {
  if (value?.checkedKeys !== 8 || value.presentKeys !== 0)
    throw new Error('A product installation already exists or registry isolation could not be verified.');
}

export function checkNsisTree(actual, reference, preserved) {
  if (!reference?.['AyCode.exe'] || !reference['resources/app.asar'] ||
      nsisFiles.some(name => Object.hasOwn(reference, name)))
    throw new Error('Invalid ZIP reference for NSIS comparison.');
  const extras = Object.fromEntries(nsisFiles.filter(name => Object.hasOwn(actual, name)).map(name => [name, actual[name]]));
  if (!extras['Uninstall AyCode.exe'] ||
      Object.values({ ...reference, ...extras }).some(hash => !exact(/^[a-f0-9]{64}$/, hash)))
    throw new Error('NSIS uninstaller evidence missing.');
  const expected = { ...reference, ...extras };
  if (Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([name, hash]) => actual[name] !== hash))
    throw new Error('NSIS application payload differs from the verified ZIP.');
  if (preserved && (Object.keys(preserved).length !== Object.keys(extras).length ||
      Object.entries(preserved).some(([name, hash]) => extras[name] !== hash)))
    throw new Error('NSIS uninstaller files were removed or changed by the update.');
  return extras;
}

export function checkNsisRegistration(value, version, key) {
  if (value?.count !== 1 || value.key !== NSIS_PRODUCT_GUID ||
      (key !== undefined && value.key !== key) || value.displayVersion !== version ||
      value.uninstallMatches !== true || value.quietUninstallMatches !== true ||
      value.uninstallerExists !== true || value.installLocationMatches !== true)
    throw new Error('NSIS registration does not identify the installed version and existing uninstaller.');
}

export function nsisRegistrationObservation(value, startVersion, targetVersion, key) {
  return {
    count: Number.isInteger(value?.count) && value.count >= 0 && value.count <= 8 ? value.count : null,
    sameEntry: key === undefined ? null : value?.key === key,
    displayVersion: [startVersion, targetVersion].includes(value?.displayVersion) ? value.displayVersion : 'other',
    uninstallMatches: value?.uninstallMatches === true,
    quietUninstallMatches: value?.quietUninstallMatches === true,
    uninstallerExists: value?.uninstallerExists === true,
    installLocationMatches: value?.installLocationMatches === true,
  };
}

export const NSIS_PHASES = Object.freeze({
  validateHost: 'validate disposable NSIS host', readExistingRegistration: 'read existing NSIS registration',
  validateFreshRegistration: 'validate fresh NSIS registration', beforeProcesses: 'check pre-install NSIS process absence',
  verifyInstaller: 'reverify NSIS installer bytes', startInstaller: 'start verified silent NSIS installer',
  waitInstaller: 'wait for silent NSIS installer exit', validateExit: 'validate silent NSIS installer exit',
  afterProcesses: 'check silent NSIS app absence', readTree: 'read installed NSIS payload',
  validateTree: 'validate installed NSIS payload', readRegistration: 'read installed NSIS registration',
  validateRegistration: 'validate installed NSIS registration',
});
const nsisPhases = new Set(Object.values(NSIS_PHASES));
export const isNsisPhase = value => nsisPhases.has(value);
const nsisErrors = new Map([
  ['NSIS requires the isolated disposable Windows 2025 review workflow.', 'host-mismatch'],
  ['A product installation already exists or registry isolation could not be verified.', 'existing-registration'],
  ['Synthetic NSIS installation is not fresh.', 'existing-process'],
  ['Verified installer must remain a regular file.', 'installer-not-regular'],
  ['Package hash/size mismatch.', 'installer-integrity'],
  ['NSIS installation failed.', 'installer-exit-failed'],
  ['NSIS installer timed out.', 'installer-timeout'],
  ['Silent NSIS unexpectedly started the application.', 'unexpected-autostart'],
  ['Unexpected link in verified application tree.', 'tree-link'],
  ['Unexpected special file in application tree.', 'tree-special-file'],
  ['Invalid ZIP reference for NSIS comparison.', 'invalid-reference'],
  ['NSIS uninstaller evidence missing.', 'uninstaller-missing'],
  ['NSIS application payload differs from the verified ZIP.', 'payload-mismatch'],
  ['NSIS uninstaller files were removed or changed by the update.', 'uninstaller-changed'],
  ['NSIS registration does not identify the installed version and existing uninstaller.', 'registration-mismatch'],
]);
const nsisCodes = new Map([
  ['ENOENT', 'file-not-found'], ['ENOTDIR', 'not-directory'], ['EACCES', 'access-denied'], ['EPERM', 'permission-denied'],
  ['EBUSY', 'file-busy'], ['ENOSPC', 'disk-full'], ['EINVAL', 'invalid-operation'], ['ETIMEDOUT', 'command-timeout'],
]);
function diagnosticField(value, key) { try { return value?.[key]; } catch { return undefined; } }
const diagnosticNumber = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
const diagnosticBoolean = value => typeof value === 'boolean' ? value : null;
const diagnosticEnum = (value, allowed) => value === undefined ? 'missing' : allowed.includes(value) ? value : 'other';
const treeCounts = ['actualFiles', 'referenceFiles', 'missingFiles', 'changedFiles', 'unexpectedFiles'];
const treeFlags = ['executableMatches', 'asarMatches', 'uninstallerPresent', 'iconPresent'];

/** Only counts/known-file equality, derived from the snapshots already required by the gate. */
export function nsisTreeObservation(actual, reference) {
  const names = Object.keys(actual), required = Object.keys(reference);
  return {
    actualFiles: names.length, referenceFiles: required.length,
    missingFiles: required.filter(name => !Object.hasOwn(actual, name)).length,
    changedFiles: required.filter(name => Object.hasOwn(actual, name) && actual[name] !== reference[name]).length,
    unexpectedFiles: names.filter(name => !Object.hasOwn(reference, name) && !nsisFiles.includes(name)).length,
    executableMatches: Object.hasOwn(actual, 'AyCode.exe') && actual['AyCode.exe'] === reference['AyCode.exe'],
    asarMatches: Object.hasOwn(actual, 'resources/app.asar') && actual['resources/app.asar'] === reference['resources/app.asar'],
    uninstallerPresent: Object.hasOwn(actual, 'Uninstall AyCode.exe'),
    iconPresent: Object.hasOwn(actual, 'uninstallerIcon.ico'),
  };
}

export function nsisDiagnosticObservation(value) {
  const get = key => diagnosticField(value, key);
  const phase = get('phase');
  const error = get('error'), installer = get('installer'), registration = get('registration'), tree = get('tree');
  const message = diagnosticField(error, 'message');
  const commandExitCode = diagnosticNumber(diagnosticField(error, 'status'), -2147483648, 4294967295);
  const errorClass = nsisErrors.get(message) || nsisCodes.get(diagnosticField(error, 'code')) ||
    (commandExitCode !== null ? 'command-failed' : 'unknown');
  const result = {
    phase: isNsisPhase(phase) ? phase : 'other',
    failure: { errorClass, commandExitCode },
    installer: {
      state: diagnosticEnum(diagnosticField(installer, 'state'), ['not-started', 'pending', 'exited', 'spawn-error']),
      exitCode: diagnosticNumber(diagnosticField(installer, 'exitCode'), -2147483648, 4294967295),
      signal: diagnosticField(installer, 'signal') === null ? null
        : diagnosticEnum(diagnosticField(installer, 'signal'), ['SIGTERM', 'SIGKILL', 'SIGABRT']),
      elapsedMs: diagnosticNumber(diagnosticField(installer, 'elapsedMs'), 0, 120000),
    },
    registration: { checkedKeys: diagnosticNumber(diagnosticField(registration, 'checkedKeys'), 0, 8),
      presentKeys: diagnosticNumber(diagnosticField(registration, 'presentKeys'), 0, 8) },
    beforeProcesses: diagnosticNumber(get('beforeProcesses'), 0, 1024),
    afterProcesses: diagnosticNumber(get('afterProcesses'), 0, 1024),
  };
  if (tree !== undefined) result.tree = Object.fromEntries([
    ...treeCounts.map(key => [key, diagnosticNumber(diagnosticField(tree, key), 0, 100000)]),
    ...treeFlags.map(key => [key, diagnosticBoolean(diagnosticField(tree, key))]),
  ]);
  return result;
}

export function requiresStableUi(expected) {
  checkPhase(expected);
  return expected.proofKind !== 'pre-release-helper';
}

export function checkRelease(release, expected, channel) {
  const review = upgradeRoute(expected).review && channel === 'stable';
  if (
    !['stable', 'nightly'].includes(channel) ||
    release?.draft !== review ||
    release.prerelease !== (channel === 'nightly' || review) ||
    release.tag_name !== (review ? `ci-windows-updater-${expected.stablePipelineId}` : `v${expected[channel + 'Version']}`) ||
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
  const review = upgradeRoute(expected).review && channel === 'stable';
  if (
    !['stable', 'nightly'].includes(channel) ||
    source?.version !== expected[channel + 'Version'] ||
    source.commit !== expected[channel + 'SourceCommit'] ||
    String(source.pipeline) !== expected[channel + 'PipelineId']
  )
    throw new Error('Signed source identity mismatch.');
  if (channel === 'nightly' && source.channel !== 'nightly')
    throw new Error('Signed nightly channel mismatch.');
  if (review && (source.purpose !== 'review' || source.platform !== 'windows' ||
      !exact(/^[1-9]\d{0,15}$/, String(source.job ?? '')) || !Number.isSafeInteger(Number(source.job))))
    throw new Error('Signed Windows review provenance is missing.');
  if (!review && source.purpose === 'review')
    throw new Error('Review packages cannot stand in for published releases.');
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
  const route = upgradeRoute(expected);
  // UpdateStatus omits channelSwitch on a normal higher-version offer.
  const correctSwitch = route.channelSwitch
    ? status?.channelSwitch === true
    : status?.channelSwitch === undefined || status?.channelSwitch === false;
  if (
    status?.state !== state ||
    status.channel !== route.target ||
    status.currentVersion !== expected[route.start + 'Version'] ||
    status.version !== expected[route.target + 'Version'] ||
    !correctSwitch ||
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

export function checkReviewHandoff(markers) {
  if (!exact(/^[a-f0-9]{64}$/, markers?.ready) || markers.commit !== markers.ready ||
      markers.cancelExists !== false || markers.pendingExists !== false)
    throw new Error('The corrected helper handoff was not uniquely committed.');
}
