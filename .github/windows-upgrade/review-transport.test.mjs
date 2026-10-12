import test from 'node:test';
import assert from 'node:assert/strict';
import { packageRequest } from './review-transport.mjs';
const expected = { proofKind: 'review-updater', stableVersion: '7.4.6', nightlyVersion: '7.4.7-nightly.202610112047.227', stableSourceCommit: 'a'.repeat(40), nightlySourceCommit: 'b'.repeat(40) };
test('review token is restricted to the initial GitHub API request and never reaches the app target', async () => {
 const seen = [];
 const fetcher = async (url, init) => {
  seen.push({ url: String(url), headers: init.headers });
  return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/owned' } }) : new Response('zip');
 };
 await packageRequest('stable', expected, 'https://api.github.com/repos/Ayont/AyCode/releases/assets/1', 'TEST_TOKEN', fetcher);
 assert.equal(seen[0].headers.Authorization, 'Bearer TEST_TOKEN');
 assert.equal(seen[1].headers.Authorization, undefined);
 const targetFetcher = async (_url, init) => { assert.equal(init.headers.Authorization, undefined); return new Response('[]'); };
 await packageRequest('nightly', expected, 'https://cloud.aycode.ai/v1/releases/nightly', 'TEST_TOKEN', targetFetcher);
 await packageRequest('stable', { ...expected, proofKind: 'final-release', nightlySourceCommit: expected.stableSourceCommit }, 'https://api.github.com/repos/Ayont/AyCode/releases/1', 'TEST_TOKEN', targetFetcher);
});
test('draft access has no anonymous fallback and rejects unrelated endpoints before requesting', async () => {
 let requests = 0;
 const fetcher = async () => { requests++; return new Response('{}'); };
 assert.throws(() => packageRequest('stable', expected, 'https://api.github.com/repos/Ayont/AyCode/releases/1', undefined, fetcher));
 for (const url of ['https://evil.test/', 'https://api.github.com@evil.test/', 'https://api.github.com/repos/Ayont/AyCode/releases/1?x=1', 'https://api.github.com/repos/Ayont/AyCode/releases/1#fragment'])
  assert.throws(() => packageRequest('stable', expected, url, 'TEST_TOKEN', fetcher));
 await assert.rejects(packageRequest('stable', expected, 'https://api.github.com/repos/Ayont/private/releases/1', 'TEST_TOKEN', fetcher));
 await assert.rejects(packageRequest('stable', expected, 'https://api.github.com/user', 'TEST_TOKEN', fetcher));
 assert.equal(requests, 0);
});
test('review workflow scopes draft credentials to download and labels the proof separately', async () => {
 const { readFile } = await import('node:fs/promises');
 const workflow = await readFile(new URL('../workflows/windows-review-upgrade.yml', import.meta.url), 'utf8');
 assert.match(workflow, /AYCODE_PROOF_KIND: review-updater/);
 assert.match(workflow, /persist-credentials: false/);
 assert.match(workflow, /github\.event_name == 'workflow_dispatch'.*github\.repository == 'Ayont\/AyCode'.*github\.ref == 'refs\/heads\/main'/);
 assert.equal((workflow.match(/GH_TOKEN:/g) || []).length, 1);
 const download = workflow.indexOf('run: node prepare.mjs');
 const token = workflow.indexOf('GH_TOKEN:');
 const run = workflow.indexOf('run: node run.mjs');
 assert.ok(download > 0 && token > download && token < run);
 assert.doesNotMatch(workflow.slice(run), /GH_TOKEN|github\.token/);
 assert.match(workflow, /node --test verify\.test\.mjs review-transport\.test\.mjs install-diagnostics\.test\.mjs launcher-bootstrap\.test\.mjs/);
 assert.doesNotMatch(workflow, /npm test|gh release|--publish/);
});
