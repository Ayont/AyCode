import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { inputs, checkRelease, checkedRedirect, cleanEnvironment, signedManifest, checkSource, checkUpdate, request } from './verify.mjs';
const expected = { proofKind: 'final-release', stableVersion: '7.4.6', nightlyVersion: '7.4.7-nightly.202610121000.240', stableSourceCommit: 'a'.repeat(40), nightlySourceCommit: 'a'.repeat(40), stableReleaseId: '100', stablePipelineId: '240', nightlyPipelineId: '241', stableManifestSha256: 'b'.repeat(64), nightlyManifestSha256: 'c'.repeat(64) };
const env = Object.fromEntries(Object.entries(expected).map(([k,v]) => ['AYCODE_'+k.replace(/[A-Z]/g,c=>'_'+c).toUpperCase(),v]));
const hash = b => createHash('sha256').update(b).digest('hex');
const stable = { id: 100, draft: false, prerelease: false, tag_name: 'v7.4.6', assets: [] };
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
