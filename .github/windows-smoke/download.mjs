import { createHash, verify } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';
const REPO = '/repos/Ayont/AyCode';
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlPWYoCb9ZF7jDSMFdEBDc1DLdwbISZRkch3EXIx0NhM=
-----END PUBLIC KEY-----`;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function inputs(env) {
  const values = { releaseId: env.AYCODE_RELEASE_ID, version: env.AYCODE_VERSION,
    sourceCommit: env.AYCODE_SOURCE_COMMIT, pipelineId: env.AYCODE_PIPELINE_ID, manifestSha256: env.AYCODE_MANIFEST_SHA256 };
  for (const key of ['releaseId', 'pipelineId']) if (!/^[1-9]\d{0,19}$/.test(values[key] ?? '')) throw new Error(`Invalid ${key}.`);
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(values.version ?? '')) throw new Error('Invalid version.');
  if (!/^[a-f0-9]{40}$/.test(values.sourceCommit ?? '')) throw new Error('Invalid source commit.');
  if (!/^[a-f0-9]{64}$/.test(values.manifestSha256 ?? '')) throw new Error('Invalid manifest hash.');
  return values;
}

/** Never forward GitHub authentication onto an asset CDN or a redirect URL. */
export async function request(apiPath, token, accept, fetcher = fetch) {
  if (!new RegExp(`^${REPO}/releases/(?:[1-9]\\d*|assets/[1-9]\\d*)$`).test(apiPath)) throw new Error('Unapproved GitHub API path.');
  let url = new URL(apiPath, API);
  const signal = AbortSignal.timeout(5 * 60_000);
  for (let hop = 0; hop < 5; hop++) {
    const headers = { Accept: accept, 'User-Agent': 'AyCode-public-package-check', 'X-GitHub-Api-Version': '2022-11-28' };
    if (hop === 0 && token) headers.Authorization = `Bearer ${token}`;
    const response = await fetcher(url, { headers, redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub release download failed (HTTP ${response.status}). Draft access must be verified; no anonymous or latest-release fallback is allowed.`); }
      return response;
    }
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Asset redirect has no destination.');
    const next = new URL(location, url);
    if (next.protocol !== 'https:' || next.username || next.password || next.port || !ASSET_HOSTS.has(next.hostname)) throw new Error('Unapproved asset redirect.');
    url = next;
  }
  throw new Error('Too many asset redirects.');
}

export async function bytes(response, limit) {
  if (!response.body) throw new Error('Empty response.');
  const parts = []; let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > limit) throw new Error('Response exceeds its size limit.');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

export function signedManifest(sums, signature, expectedHash, publicKey = PUBLIC_KEY) {
  if (sha256(sums) !== expectedHash) throw new Error('Manifest identity differs from the requested pipeline.');
  const encoded = signature.toString('utf8').trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded) || !verify(null, sums, publicKey, Buffer.from(encoded, 'base64'))) throw new Error('Invalid publisher signature.');
  const entries = new Map();
  const lines = sums.toString('utf8').trimEnd().split('\n');
  if (lines.length > 30) throw new Error('Unexpected manifest size.');
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,149})$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error('Invalid or duplicate manifest entry.');
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function releaseAssets(release, expected) {
  if (String(release.id) !== expected.releaseId || release.tag_name !== `v${expected.version}` || !Array.isArray(release.assets)) throw new Error('Release identity mismatch.');
  const wanted = [`AyCode-${expected.version}-win-x64.zip`, `AyCode-Setup-${expected.version}-win-x64.exe`, 'release.json', 'SHA256SUMS', 'SHA256SUMS.sig'];
  return Object.fromEntries(wanted.map((name) => {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1 || !Number.isSafeInteger(matches[0].size) || matches[0].size < 1 || matches[0].size > 1024 ** 3 || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest ?? '')) throw new Error(`Missing or invalid asset: ${name}`);
    return [name, matches[0]];
  }));
}

export function checkSource(source, expected) {
  if (source.version !== expected.version || source.commit !== expected.sourceCommit || String(source.pipeline) !== expected.pipelineId) throw new Error('Signed source commit/pipeline mismatch.');
}

async function download(asset, destination, expectedHash, token) {
  if (asset.digest !== `sha256:${expectedHash}`) throw new Error(`GitHub digest differs for ${asset.name}.`);
  const response = await request(`${REPO}/releases/assets/${asset.id}`, token, 'application/octet-stream');
  if (!response.body) throw new Error('Empty asset.');
  const handle = await open(destination, 'wx');
  const hash = createHash('sha256'); let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > asset.size) throw new Error('Asset exceeds its recorded size.');
      hash.update(chunk); await handle.writeFile(chunk);
    }
  } finally { await handle.close(); }
  if (size !== asset.size || hash.digest('hex') !== expectedHash) throw new Error(`Asset integrity mismatch: ${asset.name}`);
}

export async function main(env = process.env) {
  const expected = inputs(env);
  if (!env.AYCODE_SMOKE_ROOT) throw new Error('Missing temporary workspace.');
  const root = env.AYCODE_SMOKE_ROOT;
  await mkdir(root, { recursive: false });
  const release = JSON.parse((await bytes(await request(`${REPO}/releases/${expected.releaseId}`, env.GH_TOKEN, 'application/vnd.github+json'), 1024 ** 2)).toString('utf8'));
  const assets = releaseAssets(release, expected);
  const getSmall = async (name) => {
    const asset = assets[name];
    if (asset.size > 256 * 1024) throw new Error('Oversized release metadata.');
    const data = await bytes(await request(`${REPO}/releases/assets/${asset.id}`, env.GH_TOKEN, 'application/octet-stream'), asset.size);
    if (data.length !== asset.size || `sha256:${sha256(data)}` !== asset.digest) throw new Error(`Metadata integrity mismatch: ${name}`);
    return data;
  };
  const sums = await getSmall('SHA256SUMS');
  const signature = await getSmall('SHA256SUMS.sig');
  const manifest = signedManifest(sums, signature, expected.manifestSha256);
  for (const [name, asset] of Object.entries(assets)) {
    if (name === 'SHA256SUMS' || name === 'SHA256SUMS.sig') continue;
    const hash = manifest.get(name);
    if (!hash) throw new Error(`Unsigned asset: ${name}`);
    await download(asset, join(root, name), hash, env.GH_TOKEN);
    if (name === 'release.json') checkSource(JSON.parse(await readFile(join(root, name), 'utf8')), expected);
  }
  const proof = { ...expected, draft: release.draft, assets: Object.fromEntries(Object.entries(assets).map(([name, value]) => [name, value.digest.slice(7)])) };
  await writeFile(join(root, 'verified-candidate.json'), JSON.stringify(proof));
  console.log(`Verified signed release ${expected.releaseId}, source ${expected.sourceCommit}, pipeline ${expected.pipelineId}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
