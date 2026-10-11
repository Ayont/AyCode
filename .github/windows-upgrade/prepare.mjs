import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inputs, request, bytes, sha256, signedManifest, checkRelease, checkSource } from './verify.mjs';

const expected = inputs(process.env);
const root = process.env.AYCODE_UPGRADE_ROOT;
if (!root)
  throw new Error('Missing new temporary workspace.');
await mkdir(root, {
  recursive: false
});

for (const channel of ['stable', 'nightly']) {
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
  const names = [`AyCode-${version}-win-x64.zip`, 'release.json', 'SHA256SUMS', 'SHA256SUMS.sig'];
  const assets = Object.fromEntries(names.map(name => {
    const matches = release.assets.filter(asset => asset.name === name);
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(asset?.id) ||
      asset.id < 1 ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > 1024 ** 3 ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')
    )
      throw new Error('Missing, duplicate or invalid public release asset.');
    return [name, asset];
  }));

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

  const zipName = names[0];
  const zip = assets[zipName];
  const zipHash = manifest.get(zipName);
  if (!zipHash || zip.digest !== `sha256:${zipHash}`)
    throw new Error('ZIP lacks exact publisher signature.');
  const directory = join(root, channel);
  await mkdir(directory);
  for (const [name, data] of [
    ['SHA256SUMS', sums],
    ['SHA256SUMS.sig', signature],
    ['release.json', source]
  ])
    await writeFile(join(directory, name), data, { flag: 'wx' });

  const destination = await open(join(directory, zipName), 'wx');
  const hash = createHash('sha256');
  let size = 0;
  try {
    const response = await request(assetURL(zip.id));
    if (!response.body)
      throw new Error('Empty ZIP response.');
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > zip.size)
        throw new Error('ZIP exceeds recorded size.');
      hash.update(chunk);
      await destination.writeFile(chunk);
    }
  } finally {
    await destination.close();
  }
  if (size !== zip.size || hash.digest('hex') !== zipHash)
    throw new Error('ZIP hash/size mismatch.');

  await writeFile(join(directory, 'verified.json'), JSON.stringify({
    channel,
    version,
    sourceCommit: expected[channel + 'SourceCommit'],
    pipelineId: expected[channel + 'PipelineId'],
    manifestSha256: expected[channel + 'ManifestSha256'],
    zipName,
    zipSha256: zipHash
  }), {
    flag: 'wx'
  });
  console.log(`Verified public ${channel}: ${version}.`);
}
await writeFile(join(root, 'verified-inputs.json'), JSON.stringify(expected), {
  flag: 'wx'
});
