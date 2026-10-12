import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inputs, bytes, sha256, signedManifest, checkRelease, checkSource, upgradeRoute,
  packageNames, releaseAsset, signedAssetHash, checkAssetBytes } from './verify.mjs';
import { packageRequest } from './review-transport.mjs';

const expected = inputs(process.env);
const root = process.env.AYCODE_UPGRADE_ROOT;
if (!root)
  throw new Error('Missing new temporary workspace.');
await mkdir(root, {
  recursive: false
});

for (const channel of ['stable', 'nightly']) {
  const request = url => packageRequest(channel, expected, url, process.env.GH_TOKEN);
  const metadataURL = channel === 'stable'
    ? `https://api.github.com/repos/Ayont/AyCode/releases/${expected.stableReleaseId}`
    : 'https://cloud.aycode.ai/v1/releases/nightly';
  const metadata = JSON.parse((await bytes(await request(metadataURL), 8 * 1024 ** 2)).toString('utf8'));
  let release = metadata;
  if (channel === 'nightly') {
    if (!Array.isArray(metadata))
      throw new Error('Public nightly list missing.');
    const matching = metadata.filter(item => item.tag_name === `v${expected.nightlyVersion}`);
    if (matching.length !== 1)
      throw new Error('Exact published nightly is unavailable or duplicated.');
    release = matching[0];
  }

  checkRelease(release, expected, channel);
  const version = expected[channel + 'Version'];
  const packages = packageNames(expected, channel);
  const names = [...packages, 'release.json', 'SHA256SUMS', 'SHA256SUMS.sig'];
  const assets = Object.fromEntries(names.map(name => [name, releaseAsset(release, name)]));

  const assetURL = id => channel === 'stable'
    ? `https://api.github.com/repos/Ayont/AyCode/releases/assets/${id}`
    : `https://cloud.aycode.ai/v1/releases/nightly/assets/${id}`;
  const small = async name => {
    const asset = assets[name];
    if (asset.size > 256 * 1024)
      throw new Error('Metadata is too large.');
    const data = await bytes(await request(assetURL(asset.id)), asset.size);
    if (data.length !== asset.size || `sha256:${sha256(data)}` !== asset.digest)
      throw new Error('Public metadata integrity mismatch.');
    return data;
  };

  const sums = await small('SHA256SUMS');
  const signature = await small('SHA256SUMS.sig');
  const manifest = signedManifest(sums, signature, expected[channel + 'ManifestSha256']);
  const source = await small('release.json');
  if (manifest.get('release.json') !== sha256(source))
    throw new Error('Source metadata lacks publisher signature.');
  checkSource(JSON.parse(source), expected, channel);

  // The installer has an independent manifest entry; a signed ZIP never authorizes an EXE.
  for (const name of packages) signedAssetHash(assets[name], name, manifest);
  const zipName = packages[0];
  const zipHash = manifest.get(zipName);
  const directory = join(root, channel);
  await mkdir(directory);
  for (const [name, data] of [
    ['SHA256SUMS', sums],
    ['SHA256SUMS.sig', signature],
    ['release.json', source]
  ])
    await writeFile(join(directory, name), data, { flag: 'wx' });

  const packageRecords = {};
  for (const name of packages) {
    const asset = assets[name];
    const destination = await open(join(directory, name), 'wx');
    const hash = createHash('sha256');
    let size = 0;
    try {
      const response = await request(assetURL(asset.id));
      if (!response.body) throw new Error('Empty package response.');
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > asset.size) throw new Error('Package exceeds recorded size.');
        hash.update(chunk);
        await destination.writeFile(chunk);
      }
    } finally {
      await destination.close();
    }
    checkAssetBytes(asset, size, hash.digest('hex'));
    packageRecords[name] = { name, id: asset.id, size: asset.size, digest: asset.digest };
  }

  await writeFile(join(directory, 'verified.json'), JSON.stringify({
    channel,
    version,
    sourceCommit: expected[channel + 'SourceCommit'],
    pipelineId: expected[channel + 'PipelineId'],
    manifestSha256: expected[channel + 'ManifestSha256'],
    zipName,
    zipSha256: zipHash,
    packages: packageRecords
  }), {
    flag: 'wx'
  });
  console.log(`Verified ${upgradeRoute(expected).review && channel === 'stable' ? 'private review' : 'public ' + channel}: ${version}.`);
}
await writeFile(join(root, 'verified-inputs.json'), JSON.stringify(expected), {
  flag: 'wx'
});
