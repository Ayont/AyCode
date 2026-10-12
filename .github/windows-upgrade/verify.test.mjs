import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { inputs, checkRelease, checkedRedirect, cleanEnvironment, signedManifest, checkSource, checkUpdate, request } from './verify.mjs';
const expected = { proofKind: 'final-release', stableVersion: '7.4.6', nightlyVersion: '7.4.7-nightly.202610121000.240', stableSourceCommit: 'a'.repeat(40), nightlySourceCommit: 'a'.repeat(40), stableReleaseId: '100', stablePipelineId: '240', nightlyPipelineId: '241', stableManifestSha256: 'b'.repeat(64), nightlyManifestSha256: 'c'.repeat(64) };
const env = Object.fromEntries(Object.entries(expected).map(([k,v]) => ['AYCODE_'+k.replace(/[A-Z]/g,c=>'_'+c).toUpperCase(),v]));
const hash = b => createHash('sha256').update(b).digest('hex');
const stable = { id: 100, draft: false, prerelease: false, tag_name: 'v7.4.6', assets: [] };
const review = { ...expected, proofKind: 'review-updater', stableSourceCommit: 'd'.repeat(40) };
const nsis = { ...review, proofKind: 'review-updater-nsis' };
test('NSIS is an explicit review-only starting mode and does not relax the final release', async () => {
 const { installationMode, packageNames, upgradeRoute } = await import('./verify.mjs');
 const values = Object.fromEntries(Object.entries(nsis).map(([k,v]) => ['AYCODE_'+k.replace(/[A-Z]/g,c=>'_'+c).toUpperCase(),v]));
 assert.deepEqual(inputs(values), nsis);
 assert.equal(installationMode(nsis), 'nsis');
 for (const candidate of [expected, review]) assert.equal(installationMode(candidate), 'zip');
 assert.deepEqual(upgradeRoute(nsis), upgradeRoute(review));
 assert.deepEqual(packageNames(review, 'stable'), ['AyCode-7.4.6-win-x64.zip']);
 assert.deepEqual(packageNames(nsis, 'stable'), ['AyCode-7.4.6-win-x64.zip', 'AyCode-Setup-7.4.6-win-x64.exe']);
 assert.deepEqual(packageNames(nsis, 'nightly'), [`AyCode-${nsis.nightlyVersion}-win-x64.zip`]);
 for (const patch of [{ AYCODE_PROOF_KIND: 'final-release' }, { AYCODE_PROOF_KIND: 'review-updater-nsis ' },
  { AYCODE_STABLE_SOURCE_COMMIT: nsis.nightlySourceCommit }, { AYCODE_STABLE_VERSION: '7.4.7' }])
  assert.throws(() => inputs({ ...values, ...patch }));
 assert.throws(() => packageNames(nsis, 'other'));
});
test('NSIS executable needs its own exact signed asset, size and digest', async () => {
 const { releaseAsset, signedAssetHash, checkAssetBytes } = await import('./verify.mjs');
 const name = 'AyCode-Setup-7.4.6-win-x64.exe';
 const asset = { name, id: 42, size: 512, digest: 'sha256:'+'a'.repeat(64) };
 const manifest = new Map([[name, 'a'.repeat(64)]]);
 assert.equal(releaseAsset({ assets: [asset] }, name), asset);
 assert.equal(signedAssetHash(asset, name, manifest), 'a'.repeat(64));
 assert.doesNotThrow(() => checkAssetBytes(asset, 512, 'a'.repeat(64)));
 for (const patch of [{ size: 0 }, { size: '512' }, { size: 1024**3+1 }, { id: 0 }, { name: 'else.exe' }, { digest: 'sha256:'+'b'.repeat(64) }])
  assert.throws(() => signedAssetHash({ ...asset, ...patch }, name, manifest));
 assert.throws(() => releaseAsset({ assets: [asset, asset] }, name));
 assert.throws(() => signedAssetHash(asset, name, new Map([['AyCode-7.4.6-win-x64.zip', 'a'.repeat(64)]])));
 assert.throws(() => checkAssetBytes(asset, 511, 'a'.repeat(64)));
 assert.throws(() => checkAssetBytes(asset, 512, 'b'.repeat(64)));
 const { privateKey, publicKey } = generateKeyPairSync('ed25519');
 const sums = Buffer.from(`${'a'.repeat(64)}  ${name}\n`);
 const signature = Buffer.from(sign(null, sums, privateKey).toString('base64'));
 assert.equal(signedAssetHash(asset, name, signedManifest(sums, signature, hash(sums), publicKey)), 'a'.repeat(64));
 assert.throws(() => signedManifest(sums, signature, 'b'.repeat(64), publicKey));
});
test('NSIS launch is confined to the exact disposable Windows 2025 workflow directory', async () => {
 const { checkNsisHost } = await import('./verify.mjs');
 const host = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Ayont/AyCode', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', ImageOS: 'win25',
  RUNNER_TEMP: 'C:\\runner\\temp', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' };
 const root = 'C:\\runner\\temp\\aycode-review-upgrade-100-1';
 assert.doesNotThrow(() => checkNsisHost(host, root));
 assert.doesNotThrow(() => checkNsisHost({ ...host, ImageOS: 'win25-vs2026' }, root));
 for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { ImageOS: 'win22' },
  { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_REF: 'refs/heads/other' }, { GITHUB_RUN_ID: '../100' }, { RUNNER_OS: 'Linux' }])
  assert.throws(() => checkNsisHost({ ...host, ...patch }, root));
 for (const path of ['C:\\Users\\real', root+'-other', 'C:\\runner\\temp', root+'\\..\\else'])
  assert.throws(() => checkNsisHost(host, path));
});
test('NSIS permits only observed exact uninstaller extras and requires their byte preservation', async () => {
 const { checkNsisTree } = await import('./verify.mjs');
 const reference = { 'AyCode.exe': 'a'.repeat(64), 'resources/app.asar': 'b'.repeat(64) };
 const extras = { 'Uninstall AyCode.exe': 'c'.repeat(64), 'uninstallerIcon.ico': 'd'.repeat(64) };
 assert.deepEqual(checkNsisTree({ ...reference, ...extras }, reference), extras);
 assert.deepEqual(checkNsisTree({ ...reference, ...extras }, reference, extras), extras);
 assert.deepEqual(checkNsisTree({ ...reference, 'Uninstall AyCode.exe': extras['Uninstall AyCode.exe'] }, reference),
  { 'Uninstall AyCode.exe': extras['Uninstall AyCode.exe'] });
 for (const actual of [reference, { ...reference, ...extras, 'uninstall-other.exe': 'a'.repeat(64) },
  { ...reference, ...extras, 'resources/Uninstall AyCode.exe': 'a'.repeat(64) },
  { ...reference, ...extras, 'AyCode.exe': 'e'.repeat(64) }]) assert.throws(() => checkNsisTree(actual, reference));
 for (const actual of [{ ...reference, 'Uninstall AyCode.exe': extras['Uninstall AyCode.exe'] },
  { ...reference, ...extras, 'Uninstall AyCode.exe': 'e'.repeat(64) }]) assert.throws(() => checkNsisTree(actual, reference, extras));
 assert.throws(() => checkNsisTree({ ...reference, ...extras }, { ...reference, ...extras }));
});
test('NSIS registry evidence requires the same entry, exact target version and a live uninstaller', async () => {
 const { checkNsisRegistration, NSIS_PRODUCT_GUID } = await import('./verify.mjs');
 const before = { key: NSIS_PRODUCT_GUID, count: 1,
  uninstallMatches: true, quietUninstallMatches: true, uninstallerExists: true, installLocationMatches: true, displayVersion: '7.4.6' };
 assert.doesNotThrow(() => checkNsisRegistration(before, '7.4.6'));
 const after = { ...before, displayVersion: nsis.nightlyVersion };
 assert.doesNotThrow(() => checkNsisRegistration(after, nsis.nightlyVersion, before.key));
 for (const patch of [{ count: 0 }, { count: 2 }, { key: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb' }, { uninstallMatches: false },
  { quietUninstallMatches: false }, { uninstallerExists: false }, { installLocationMatches: false }, { displayVersion: '7.4.6' }])
  assert.throws(() => checkNsisRegistration({ ...after, ...patch }, nsis.nightlyVersion, before.key));
});
test('NSIS refuses any existing product key even when its installation uses a different path', async () => {
 const { checkNsisFreshRegistration } = await import('./verify.mjs');
 assert.doesNotThrow(() => checkNsisFreshRegistration({ checkedKeys: 8, presentKeys: 0 }));
 assert.throws(() => checkNsisFreshRegistration({ checkedKeys: 8, presentKeys: 1, installPath: 'C:\\Users\\real\\AyCode' }));
 for (const patch of [{ checkedKeys: 7 }, { presentKeys: 8 }, { presentKeys: undefined }, { checkedKeys: '8' }])
  assert.throws(() => checkNsisFreshRegistration({ checkedKeys: 8, presentKeys: 0, ...patch }));
});
test('NSIS diagnostics discard unknown registry text and expose only expected versions and fixed flags', async () => {
 const { nsisRegistrationObservation } = await import('./verify.mjs');
 const safe = nsisRegistrationObservation({ count: 1, key: 'SECRET', displayVersion: 'SECRET',
  uninstallMatches: 'SECRET', quietUninstallMatches: true, uninstallerExists: false, extra: 'SECRET' }, '7.4.6', nsis.nightlyVersion, 'other');
 assert.deepEqual(safe, { count: 1, sameEntry: false, displayVersion: 'other',
  uninstallMatches: false, quietUninstallMatches: true, uninstallerExists: false, installLocationMatches: false });
 assert.equal(nsisRegistrationObservation({ displayVersion: '7.4.6' }, '7.4.6', nsis.nightlyVersion).displayVersion, '7.4.6');
});
test('review workflow chooses ZIP or NSIS explicitly on a disposable Windows 2025 runner', async () => {
 const { readFile } = await import('node:fs/promises');
 const workflow = await readFile(new URL('../workflows/windows-review-upgrade.yml', import.meta.url), 'utf8');
 assert.match(workflow, /options: \[review-updater, review-updater-nsis\]/);
 assert.match(workflow, /default: review-updater/);
 assert.ok(workflow.includes('AYCODE_PROOF_KIND: ${{ inputs.proof_kind }}'));
 assert.match(workflow, /runs-on: windows-2025/);
 assert.ok(workflow.includes('RUNNER_ENVIRONMENT: ${{ runner.environment }}'));
 const run = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
 assert.match(run, /spawn\(setup, \['\/S', `\/D=\$\{dirname\(executable\)\}`\]/);
 assert.doesNotMatch(run, /spawn\(setup,[\s\S]{0,100}--force-run/);
 assert.match(run, /checkNsisTree\(installedTree, targetTree, nsisExtras\)/);
 assert.match(run, /checkNsisRegistration\(registrationAfter, targetVersion, registrationBefore\.key\)/);
});
test('review updater direction is explicit and cannot certify the published stable updater', async () => {
 const { upgradeRoute } = await import('./verify.mjs');
 const values = Object.fromEntries(Object.entries(review).map(([k,v]) => ['AYCODE_'+k.replace(/[A-Z]/g,c=>'_'+c).toUpperCase(),v]));
 assert.deepEqual(inputs(values), review);
 assert.deepEqual(upgradeRoute(review), { start: 'stable', target: 'nightly', channelSwitch: false, review: true });
 assert.deepEqual(upgradeRoute(expected), { start: 'nightly', target: 'stable', channelSwitch: true, review: false });
 assert.throws(() => inputs({ ...values, AYCODE_STABLE_SOURCE_COMMIT: expected.nightlySourceCommit }));
 assert.throws(() => inputs({ ...values, AYCODE_STABLE_VERSION: '7.4.7' }));
 const draft = { ...stable, draft: true, prerelease: true, tag_name: 'ci-windows-updater-240' };
 assert.doesNotThrow(() => checkRelease(draft, review, 'stable'));
 for (const patch of [{ draft: false }, { prerelease: false }, { tag_name: 'v7.4.6' }, { id: 101 }])
  assert.throws(() => checkRelease({ ...draft, ...patch }, review, 'stable'));
 assert.throws(() => checkRelease(draft, expected, 'stable'));
 const source = { version: review.stableVersion, commit: review.stableSourceCommit, pipeline: review.stablePipelineId, purpose: 'review', platform: 'windows', job: '701' };
 assert.doesNotThrow(() => checkSource(source, review, 'stable'));
 for (const patch of [{ purpose: 'release' }, { purpose: undefined }, { platform: 'mac' }, { job: undefined }, { commit: expected.nightlySourceCommit }])
  assert.throws(() => checkSource({ ...source, ...patch }, review, 'stable'));
 assert.throws(() => checkSource({ ...source, commit: expected.stableSourceCommit }, expected, 'stable'));
 const offered = { state: 'available', channel: 'nightly', currentVersion: review.stableVersion, version: review.nightlyVersion, channelSwitch: false, supported: true };
 assert.doesNotThrow(() => checkUpdate(offered, review, 'available'));
 for (const patch of [{ channelSwitch: true }, { channel: 'stable' }, { version: review.stableVersion }])
  assert.throws(() => checkUpdate({ ...offered, ...patch }, review, 'available'));
});
test('review handoff requires matching exact nonce markers and no cancellation or pending write', async () => {
 const { checkReviewHandoff } = await import('./verify.mjs');
 const markers = { ready: 'a'.repeat(64), commit: 'a'.repeat(64), cancelExists: false, pendingExists: false };
 assert.doesNotThrow(() => checkReviewHandoff(markers));
 for (const patch of [{ ready: 'ready' }, { ready: 'a'.repeat(64)+'\n' }, { commit: 'b'.repeat(64) }, { cancelExists: true }, { pendingExists: true }, { cancelExists: undefined }])
  assert.throws(() => checkReviewHandoff({ ...markers, ...patch }));
});
test('inputs allow normal next-patch nightly and exact identities only', () => {
 assert.deepEqual(inputs(env), expected);
 for (const [key, value] of [['AYCODE_STABLE_RELEASE_ID','001'],['AYCODE_STABLE_SOURCE_COMMIT','a'.repeat(39)],['AYCODE_NIGHTLY_SOURCE_COMMIT','a'.repeat(39)],['AYCODE_STABLE_VERSION','7.4.6-evil'],['AYCODE_NIGHTLY_VERSION','7.4.7-nightly.202610121000\n'],['AYCODE_STABLE_MANIFEST_SHA256','B'.repeat(64)]]) assert.throws(()=>inputs({...env,[key]:value}));
});
test('only public stable and matching public nightly releases are accepted', () => {
 assert.doesNotThrow(()=>checkRelease(stable,expected,'stable'));
 for(const patch of [{draft:true},{draft:undefined},{prerelease:true},{id:101},{tag_name:'v7.4.7'}]) assert.throws(()=>checkRelease({...stable,...patch},expected,'stable'));
 assert.doesNotThrow(()=>checkRelease({...stable,id:201,prerelease:true,tag_name:`v${expected.nightlyVersion}`},expected,'nightly'));
 assert.throws(()=>checkRelease({...stable,tag_name:`v${expected.nightlyVersion}`},expected,'nightly'));
});
test('asset redirects stay on fixed HTTPS CDN origins and never use credentials', () => {
 assert.equal(checkedRedirect('https://release-assets.githubusercontent.com/file').hostname,'release-assets.githubusercontent.com');
 for(const url of ['http://release-assets.githubusercontent.com/file','https://evil.test/file','https://release-assets.githubusercontent.com.evil.test/file','https://user@release-assets.githubusercontent.com/file','https://release-assets.githubusercontent.com:444/file','https://cloud.aycode.ai/v1/elsewhere']) assert.throws(()=>checkedRedirect(url));
});
test('publisher manifest requires pinned bytes, Ed25519 and unique safe entries', () => {
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const body=Buffer.from(`${'a'.repeat(64)}  test.zip\n`);
 const signature=Buffer.from(sign(null,body,privateKey).toString('base64'));
 assert.equal(signedManifest(body,signature,hash(body),publicKey).get('test.zip'),'a'.repeat(64));
 assert.throws(()=>signedManifest(body,signature,'b'.repeat(64),publicKey));
 const duplicate=Buffer.concat([body,body]);
 assert.throws(()=>signedManifest(duplicate,Buffer.from(sign(null,duplicate,privateKey).toString('base64')),hash(duplicate),publicKey));
 assert.throws(()=>signedManifest(body,Buffer.from('A'.repeat(86)+'=='),hash(body),publicKey));
});
test('signed manifests independently bind each source and its own pipeline', () => {
 const pre = { ...expected, proofKind: 'pre-release-helper', stableVersion: '7.4.5',
   stableSourceCommit: 'd'.repeat(40), stablePipelineId: '230' };
 for (const candidate of [expected, pre]) {
  for (const channel of ['stable', 'nightly']) {
   const source = { version: candidate[channel + 'Version'],
     commit: candidate[channel + 'SourceCommit'],
     pipeline: candidate[channel + 'PipelineId'], channel };
   assert.doesNotThrow(() => checkSource(source, candidate, channel));
   assert.throws(() => checkSource({ ...source, commit: 'e'.repeat(40) }, candidate, channel));
   assert.throws(() => checkSource({ ...source, pipeline: '333' }, candidate, channel));
   assert.throws(() => checkSource({ ...source, version: '7.0.0' }, candidate, channel));
   if (candidate === pre) {
    const other = channel === 'stable' ? 'nightly' : 'stable';
    assert.throws(() => checkSource({ ...source, commit: candidate[other + 'SourceCommit'] }, candidate, channel));
   }
  }
 }
 assert.throws(() => checkSource({}, expected, 'arbitrary'));
});

test('only the explicit older-stable phase accepts different expected source commits', () => {
 const before = { ...env, AYCODE_PROOF_KIND: 'pre-release-helper',
   AYCODE_STABLE_VERSION: '7.4.5', AYCODE_STABLE_SOURCE_COMMIT: 'd'.repeat(40) };
 const parsed = inputs(before);
 assert.equal(parsed.proofKind, 'pre-release-helper');
 assert.equal(parsed.stableSourceCommit, 'd'.repeat(40));
 assert.equal(parsed.nightlySourceCommit, 'a'.repeat(40));
 for (const patch of [
  { AYCODE_PROOF_KIND: undefined },
  { AYCODE_PROOF_KIND: 'final-release' },
  { AYCODE_PROOF_KIND: 'pre-release-helper ' },
  { AYCODE_STABLE_VERSION: '7.4.4' },
  { AYCODE_STABLE_VERSION: '7.4.6' },
  { AYCODE_NIGHTLY_VERSION: '7.4.8-nightly.202610121000.240' }
 ]) assert.throws(() => inputs({ ...before, ...patch }));
});

test('final phase requires the exact 7.4.6 target and identical independently supplied sources', async () => {
 const { requiresStableUi } = await import('./verify.mjs');
 assert.equal(requiresStableUi(inputs(env)), true);
 for (const patch of [
  { AYCODE_STABLE_VERSION: '7.4.5' },
  { AYCODE_STABLE_VERSION: '7.4.7' },
  { AYCODE_NIGHTLY_SOURCE_COMMIT: 'd'.repeat(40) },
  { AYCODE_STABLE_SOURCE_COMMIT: undefined },
  { AYCODE_NIGHTLY_SOURCE_COMMIT: undefined },
  { AYCODE_PROOF_KIND: 'pre-release-helper' }
 ]) assert.throws(() => inputs({ ...env, ...patch }));
 const pre = inputs({ ...env, AYCODE_PROOF_KIND: 'pre-release-helper',
   AYCODE_STABLE_VERSION: '7.4.5', AYCODE_STABLE_SOURCE_COMMIT: 'd'.repeat(40) });
 assert.equal(requiresStableUi(pre), false);
 assert.throws(() => requiresStableUi({ ...pre, stableVersion: '7.4.6' }));
});
test('the workflow exposes separate expected sources and explicit bounded phases', async () => {
 const { readFile } = await import('node:fs/promises');
 const workflow = await readFile(new URL('./windows-upgrade.yml', import.meta.url), 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return readFile(new URL('../workflows/windows-upgrade.yml', import.meta.url), 'utf8');
 });
 assert.match(workflow, /options: \[pre-release-helper, final-release\]/);
 assert.match(workflow, /default: final-release/);
 for (const [key, input] of [
  ['PROOF_KIND', 'proof_kind'],
  ['STABLE_SOURCE_COMMIT', 'stable_source_commit'],
  ['NIGHTLY_SOURCE_COMMIT', 'nightly_source_commit']
 ]) assert.ok(workflow.includes('AYCODE_' + key + ': ${{ inputs.' + input + ' }}'));
 assert.doesNotMatch(workflow, /inputs\.source_commit|AYCODE_SOURCE_COMMIT:/);
 assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
});

test('isolated process environment excludes every CI credential and real profile', () => {
 const values=cleanEnvironment({PATH:'safe',SystemRoot:'C:\\Windows',GH_TOKEN:'secret',CI_JOB_TOKEN:'secret',NODE_OPTIONS:'bad',ELECTRON_RUN_AS_NODE:'1',USERPROFILE:'real',AYCODE_USER_DATA:'real'},'C:\\Temp\\isolated');
 assert.equal(values.SystemRoot,'C:\\Windows'); assert.equal(values.USERPROFILE,'C:\\Temp\\isolated\\home');
 for(const key of ['GH_TOKEN','CI_JOB_TOKEN','NODE_OPTIONS','ELECTRON_RUN_AS_NODE']) assert.equal(values[key],undefined);
 assert.equal(values.APPDATA,'C:\\Temp\\isolated\\home\\AppData\\Roaming');
 assert.equal(values.LOCALAPPDATA,'C:\\Temp\\isolated\\home\\AppData\\Local');
 assert.equal(values.TEMP,'C:\\Temp\\isolated\\home\\AppData\\Local\\Temp');
 assert.equal(values.TMP,values.TEMP);
});
test('regular updater must offer and stage exact stable as a channel switch', () => {
 const status={state:'available',channel:'stable',currentVersion:expected.nightlyVersion,version:expected.stableVersion,channelSwitch:true,supported:true};
 assert.doesNotThrow(()=>checkUpdate(status,expected,'available'));
 assert.doesNotThrow(()=>checkUpdate({...status,state:'ready',installMode:'restart'},expected,'ready'));
 for(const patch of [{version:'7.4.8'},{channel:'nightly'},{channelSwitch:false},{supported:false},{state:'error'}]) assert.throws(()=>checkUpdate({...status,...patch},expected,'available'));
 assert.throws(()=>checkUpdate({...status,state:'ready',installMode:'reveal'},expected,'ready'));
});
test('fixed API requester refuses injected origins and never sends authorization', async () => {
 let seen;
 const fetcher=async(url,init)=>{seen={url:String(url),init};return new Response('{}')};
 await request('https://api.github.com/repos/Ayont/AyCode/releases/100',fetcher);
 assert.equal(seen.init.redirect,'manual'); assert.equal(seen.init.credentials,'omit'); assert.equal(seen.init.headers.Authorization,undefined);
 for(const url of ['https://evil.test/','https://api.github.com/repos/Ayont/private/releases/1','https://cloud.aycode.ai/v1/releases/nightly/assets/0']) await assert.rejects(request(url,fetcher));
});

test('HTTP failure diagnoses only the fixed origin and bounded decimal rate headers', async () => {
 let calls = 0;
 const fetcher = async () => {
  calls++;
  return new Response('PRIVATE_RESPONSE_BODY', { status: 403, headers: {
   'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791764800', 'retry-after': '60',
   Authorization: 'PRIVATE_AUTHORIZATION'
  } });
 };
 await assert.rejects(request('https://api.github.com/repos/Ayont/AyCode/releases/100', fetcher), error => {
  assert.equal(error.message, 'Public download failed (HTTP 403; origin=github-api; x-ratelimit-remaining=0; x-ratelimit-reset=1791764800; retry-after=60).');
  return true;
 });
 assert.equal(calls, 1);
});

test('HTTP failure without rate headers makes no rate-limit claim', async () => {
 await assert.rejects(request('https://api.github.com/repos/Ayont/AyCode/releases/100',
  async () => new Response(null, { status: 403 })), error => {
  assert.equal(error.message, 'Public download failed (HTTP 403; origin=github-api).');
  return true;
 });
});

test('malformed, injected and out-of-range rate headers are omitted', async () => {
 const limits = { 'x-ratelimit-remaining': 1_000_000_000, 'x-ratelimit-reset': 4_294_967_295, 'retry-after': 86_400 };
 for (const value of ['0\r\nSECRET', '-1', '1e3', '0x10', ' 1 ', '001', '1.5', 'SECRET', '1'.repeat(100), 1, null]) {
  const response = { ok: false, status: 403, body: null, headers: { get: () => value } };
  await assert.rejects(request('https://api.github.com/repos/Ayont/AyCode/releases/100', async () => response), error => {
   assert.equal(error.message, 'Public download failed (HTTP 403; origin=github-api).');
   return true;
  });
 }
 const response = { ok: false, status: 403, body: null, headers: { get: name => String(limits[name] + 1) } };
 await assert.rejects(request('https://api.github.com/repos/Ayont/AyCode/releases/100', async () => response),
  { message: 'Public download failed (HTTP 403; origin=github-api).' });
});

test('HTTP diagnosis never reads sensitive headers or response body contents', async () => {
 const accessed = [];
 let cancelled = false;
 const trap = () => { throw new Error('SECRET_READ_TRAP'); };
 const response = {
  ok: false, status: 403,
  headers: {
   get(name) {
    accessed.push(name);
    assert.ok(['x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'].includes(name));
    return name === 'x-ratelimit-remaining' ? '0' : null;
   },
   entries: trap, [Symbol.iterator]: trap, toJSON: trap,
  },
  body: { cancel: async () => { cancelled = true; }, [Symbol.asyncIterator]: trap },
  text: trap, json: trap, arrayBuffer: trap,
 };
 Object.defineProperty(response, 'statusText', { get: trap });
 await assert.rejects(request('https://api.github.com/repos/Ayont/AyCode/releases/100', async () => response),
  { message: 'Public download failed (HTTP 403; origin=github-api; x-ratelimit-remaining=0).' });
 assert.equal(cancelled, true);
 assert.deepEqual(accessed, ['x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']);
});

test('HTTP diagnosis classifies the nightly gateway and approved redirect CDN without exposing URLs', async () => {
 await assert.rejects(request('https://cloud.aycode.ai/v1/releases/nightly',
  async () => new Response(null, { status: 403 })),
 { message: 'Public download failed (HTTP 403; origin=nightly-gateway).' });
 let calls = 0;
 await assert.rejects(request('https://api.github.com/repos/Ayont/AyCode/releases/assets/100', async (_url, init) => {
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers.Authorization, undefined);
  return calls++ === 0
   ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/PRIVATE_PATH?sig=SECRET' } })
   : new Response(null, { status: 403 });
 }), { message: 'Public download failed (HTTP 403; origin=github-cdn).' });
 assert.equal(calls, 2);
});

test('successful HTTP request keeps the exact response and never reads diagnostic headers', async () => {
 const response = { ok: true, status: 200, headers: { get() { throw new Error('UNEXPECTED_DIAGNOSTIC_READ'); } } };
 let calls = 0;
 assert.equal(await request('https://api.github.com/repos/Ayont/AyCode/releases/100', async () => {
  calls++;
  return response;
 }), response);
 assert.equal(calls, 1);
});

test('helper completion requires the actual successful final marker and no failure path', async () => {
 const {checkHelperLog}=await import('./verify.mjs');
 const success='2026-10-12 10:10:00 waiting for AyCode (pid 42)\r\n2026-10-12 10:10:05 updated\r\n';
 assert.doesNotThrow(()=>checkHelperLog(success));
 for(const text of ['',success.replace('updated','not updated'),success+'2026-10-12 10:10:06 relaunch failed: missing exe\n','2026-10-12 10:10:00 updated\n2026-10-12 10:10:02 restoring the previous app.']) assert.throws(()=>checkHelperLog(text));
});

test('workflow resolves runner.temp only in the concrete preparation and execution steps', async () => {
 const {readFile}=await import('node:fs/promises');
 const workflow=await readFile(new URL('./windows-upgrade.yml',import.meta.url),'utf8').catch(error=>{
  if(error.code!=='ENOENT') throw error;
  return readFile(new URL('../workflows/windows-upgrade.yml',import.meta.url),'utf8');
 });
 assert.doesNotMatch(workflow,/^      AYCODE_UPGRADE_ROOT:/m);
 for(const script of ['prepare','run']) {
  assert.match(workflow,new RegExp(`        run: node ${script}\\.mjs\\r?\\n        env:\\r?\\n          AYCODE_UPGRADE_ROOT: \\$\\{\\{ runner\\.temp \\}\\}/aycode-upgrade-`));
 }
});
