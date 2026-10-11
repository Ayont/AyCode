import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { inputs, request, bytes, signedManifest, releaseAssets, checkSource, sha256, needsAppShot } from './download.mjs';

const env = { AYCODE_RELEASE_ID: '409626651', AYCODE_VERSION: '7.4.5', AYCODE_SOURCE_COMMIT: '5964ba62fdce29c2b377d16fc764972fcbd1f137', AYCODE_PIPELINE_ID: '230', AYCODE_MANIFEST_SHA256: 'a'.repeat(64) };
const key = generateKeyPairSync('ed25519');
const signed = (sums) => Buffer.from(sign(null, sums, key.privateKey).toString('base64'));

test('strict identity rejects shell syntax, whitespace and incomplete hashes', () => {
  assert.equal(inputs(env).pipelineId, '230');
  for (const [name, value] of Object.entries({ AYCODE_RELEASE_ID: '../latest', AYCODE_VERSION: '7.4.5;whoami', AYCODE_SOURCE_COMMIT: 'a'.repeat(39), AYCODE_PIPELINE_ID: '230\n', AYCODE_MANIFEST_SHA256: 'A'.repeat(64) })) assert.throws(() => inputs({ ...env, [name]: value }));
});
test('authentication is sent only to the fixed first GitHub API request', async () => {
  const calls = [];
  const result = await request('/repos/Ayont/AyCode/releases/assets/1', 'fixture-token', 'application/octet-stream', async (url, options) => {
    calls.push({ url: String(url), headers: options.headers });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/example?signature=fixture' } }) : new Response('ok');
  });
  assert.equal(await result.text(), 'ok');
  assert.equal(calls[0].headers.Authorization, 'Bearer fixture-token');
  assert.equal(calls[1].headers.Authorization, undefined);
});
test('redirects cannot send tokens or requests to arbitrary origins', async () => {
  for (const destination of ['http://release-assets.githubusercontent.com/x', 'https://evil.test/x', 'https://api.github.com/user', 'https://user@release-assets.githubusercontent.com/x', 'https://release-assets.githubusercontent.com:444/x']) {
    let calls = 0;
    await assert.rejects(request('/repos/Ayont/AyCode/releases/1', 'fixture-token', 'application/json', async () => { calls++; return new Response(null, { status: 302, headers: { location: destination } }); }), /Unapproved/);
    assert.equal(calls, 1);
  }
  await assert.rejects(request('/repos/Other/Repo/releases/1', 'fixture-token', 'application/json'), /Unapproved/);
});
test('draft denial stays a failure and never falls back to latest or anonymous', async () => {
  let calls = 0;
  await assert.rejects(request('/repos/Ayont/AyCode/releases/1', 'fixture-token', 'application/json', async () => { calls++; return new Response(null, { status: 404 }); }), /HTTP 404/);
  assert.equal(calls, 1);
});
test('bounded reads reject oversized metadata', async () => {
  await assert.rejects(bytes(new Response('abc'), 2), /size limit/);
});
test('the pinned manifest hash and publisher signature are both required', () => {
  const sums = Buffer.from(`${'a'.repeat(64)}  release.json\n`);
  assert.equal(signedManifest(sums, signed(sums), sha256(sums), key.publicKey).get('release.json'), 'a'.repeat(64));
  assert.throws(() => signedManifest(sums, signed(sums), 'b'.repeat(64), key.publicKey), /identity/);
  assert.throws(() => signedManifest(sums, signed(sums), sha256(sums), generateKeyPairSync('ed25519').publicKey), /signature/);
});
test('even signed duplicate or traversing filenames are refused', () => {
  for (const names of ['../app.exe', 'x\n' + 'a'.repeat(64) + '  x']) {
    const sums = Buffer.from(`${'a'.repeat(64)}  ${names}\n`);
    assert.throws(() => signedManifest(sums, signed(sums), sha256(sums), key.publicKey), /entry/);
  }
});
test('release identity, unique assets and signed source identity cannot drift', () => {
  const expected = inputs(env);
  const names = ['AyCode-7.4.5-win-x64.zip', 'AyCode-Setup-7.4.5-win-x64.exe', 'release.json', 'SHA256SUMS', 'SHA256SUMS.sig'];
  const release = { id: 409626651, tag_name: 'v7.4.5', assets: names.map((name, i) => ({ id: i + 1, name, size: 2, digest: `sha256:${'a'.repeat(64)}` })) };
  assert.equal(Object.keys(releaseAssets(release, expected)).length, 5);
  assert.throws(() => releaseAssets({ ...release, tag_name: 'v7.4.6' }, expected), /identity/);
  assert.throws(() => releaseAssets({ ...release, assets: [...release.assets, release.assets[0]] }, expected), /asset/);
  checkSource({ version: '7.4.5', commit: expected.sourceCommit, pipeline: '230' }, expected);
  assert.throws(() => checkSource({ version: '7.4.5', commit: expected.sourceCommit, pipeline: '231' }, expected), /mismatch/);
});

test('AppShot packaged helper is required from 7.5.6 without lexicographic version mistakes', () => {
  for (const version of ['6.99.99', '7.4.5', '7.5.5']) assert.equal(needsAppShot(version), false);
  for (const version of ['7.5.6', '7.5.10', '7.10.0', '8.0.0', '10.0.0']) assert.equal(needsAppShot(version), true);
  for (const version of ['7.5', '7.5.6-beta', '7.5.6\n']) assert.throws(() => needsAppShot(version), /version/);
});
