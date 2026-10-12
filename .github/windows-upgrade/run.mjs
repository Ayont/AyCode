import { _electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { inputs, cleanEnvironment, signedManifest, checkSource, checkUpdate, checkHelperLog, requiresStableUi } from './verify.mjs';
import { verifyWindowsShell } from './windows-ui.mjs';
import { installFailureClass, observeInstallRequest, observeMainIdentity, reportInstallFailure } from './install-diagnostics.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Native Windows x64 required.');
const expected = inputs(process.env);
const root = process.env.AYCODE_UPGRADE_ROOT;
if (!root || !win32.isAbsolute(root))
  throw new Error('Missing isolated absolute workspace.');
const stored = JSON.parse(await readFile(join(root, 'verified-inputs.json'), 'utf8'));
for (const [key, value] of Object.entries(expected))
  if (stored[key] !== value)
    throw new Error('Prepared package identity differs.');

const environment = cleanEnvironment(process.env, root);
for (const key of ['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'AYCODE_USER_DATA'])
  await mkdir(environment[key], { recursive: true });
await mkdir(join(root, 'fixture-project'));

const ps = win32.join(
  environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
);
// Fresh profile readiness was measured on the hosted Windows runner.
async function verifyProfile() {
  // .NET delegates to Windows Known Folders without creating missing folders.
  // Avoid compiling a helper just to query the OS, and fail on runner-profile fallback.
  const script = `$ErrorActionPreference = 'Stop'
Write-Output 'AYCODE_PROFILE_STARTED'
$roaming = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
Write-Output 'AYCODE_PROFILE_ROAMING'
$local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
Write-Output 'AYCODE_PROFILE_LOCAL'
@{roamingExists=([bool]$roaming -and (Test-Path -LiteralPath $roaming -PathType Container)); localExists=([bool]$local -and (Test-Path -LiteralPath $local -PathType Container)); roamingMatches=($roaming -ieq $env:APPDATA); localMatches=($local -ieq $env:LOCALAPPDATA)} | ConvertTo-Json -Compress`;
  let output;
  const preflightStarted = Date.now();
  try {
    output = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: environment, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    }).trim();
  } catch (error) {
    const stdout = String(error.stdout || '');
    console.error(`AYCODE_PROFILE_FAILURE=${JSON.stringify({
      code: error.code, status: error.status, signal: error.signal, elapsedMs: Date.now() - preflightStarted,
      started: stdout.includes('AYCODE_PROFILE_STARTED'),
      roamingRead: stdout.includes('AYCODE_PROFILE_ROAMING'),
      localRead: stdout.includes('AYCODE_PROFILE_LOCAL'),
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(String(error.stderr || '')),
    })}`);
    throw error;
  }
  const folders = JSON.parse(output.split(/\r?\n/).at(-1));
  console.log(`AYCODE_PROFILE_PREFLIGHT=${JSON.stringify({ ...folders, elapsedMs: Date.now() - preflightStarted })}`);
  if (!folders.roamingExists || !folders.localExists ||
      !folders.roamingMatches || !folders.localMatches)
    throw new Error('Native Known Folders do not match the isolated application profile.');
}

const taskkill = win32.join(
  environment.SystemRoot || environment.SYSTEMROOT || 'C:\\Windows',
  'System32', 'taskkill.exe'
);
const executable = join(root, 'AyCode installed with spaces', 'AyCode.exe');
const reference = join(root, 'stable reference');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app,
  autoPid,
  installObservation,

  phase = 'package verification';

const fileHash = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

async function deadline(promise, label, ms = 60_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(read, accept, label, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await deadline(Promise.resolve().then(read), label, Math.max(1, end - Date.now()));
    if (accept(value)) return value;
    await delay(400);
  }
  throw new Error(`${label} not observed.`);
}

function powerShell(script, extra = {}) {
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], {
    env: {
      ...environment,
      ...extra
    },
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 1024 ** 2
  });
}

function kill(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try {
    execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
      env: environment,
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true
    });
  } catch {
    /* already exited */
  }
}

function processes() {
  const raw = powerShell(
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'AyCode.exe'\" | " +
    "Where-Object { $_.ExecutablePath -eq $env:PROBE_EXE -and $_.CommandLine -notmatch \"--type=\" } | " +
    "ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; " +
    "if ($p) { [pscustomobject]@{ pid = [int]$_.ProcessId; " +
    "path = $_.ExecutablePath; " +
    "window = [long]$p.MainWindowHandle; " +
    "responding = [bool]$p.Responding } } }); " +
    "ConvertTo-Json -InputObject $items -Compress", {
    PROBE_EXE: executable
  });
  const values = JSON.parse(raw || '[]');
  return Array.isArray(values) ? values : [values];
}

async function snapshot(directory) {
  const entries = {};
  const visit = async (current, prefix = '') => {
    for (const entry of await readdir(current, {
      withFileTypes: true
    })) {
      const key = prefix + entry.name;
      const file = join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error('Unexpected link in verified application tree.');
      if (entry.isDirectory())
        await visit(file, key + '/');
      else if (entry.isFile())
        entries[key] = await fileHash(file);
      else
        throw new Error('Unexpected special file in application tree.');
    }
  };
  await visit(directory);
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

async function start(version) {
  app = await _electron.launch({
    executablePath: executable,
    cwd: dirname(executable),
    env: environment,
    timeout: 60_000
  });
  const page = await deadline(app.firstWindow(), 'Packaged window');
  await until(
    () => page.url(),
    value => value.startsWith('file://') && value.endsWith('/renderer/index.html'),
    'Packaged renderer'
  );
  await until(() => page.evaluate(() => Boolean(window.aycode)), Boolean, 'Application bridge');
  const boot = await until(
    () => page.evaluate(() => window.aycode.bootstrap()),
    value => value.bootstrapComplete && value.engine?.state === 'ready',
    'Packaged engine'
  );
  if (boot.appVersion !== version)
    throw new Error('Running version differs from verified package.');
  if (boot.platform !== 'win32')
    throw new Error('The installed application does not identify its Windows platform.');
  return {
    page,
    boot,
    pid: app.process().pid
  };
}

async function close() {
  if (!app) return;
  const current = app;
  app = undefined;
  try {
    await deadline(current.close(), 'Controlled shutdown', 20_000);
  } catch (error) {
    kill(current.process().pid);
    throw error;
  }
}

try {
  await verifyProfile();
  const hashes = {};
  for (const channel of ['stable', 'nightly']) {
    const directory = join(root, channel);
    const version = expected[channel + 'Version'];
    const sums = await readFile(join(directory, 'SHA256SUMS'));
    const manifest = signedManifest(
      sums,
      await readFile(join(directory, 'SHA256SUMS.sig')),
      expected[channel + 'ManifestSha256']
    );
    const sourceBytes = await readFile(join(directory, 'release.json'));
    if (createHash('sha256').update(sourceBytes).digest('hex') !== manifest.get('release.json'))
      throw new Error('Signed source metadata changed.');
    checkSource(JSON.parse(sourceBytes), expected, channel);
    const zip = join(directory, `AyCode-${version}-win-x64.zip`);
    hashes[channel] = await fileHash(zip);
    if (hashes[channel] !== manifest.get(`AyCode-${version}-win-x64.zip`))
      throw new Error('Verified ZIP changed.');
    powerShell('Expand-Archive -LiteralPath $env:PROBE_ZIP -DestinationPath $env:PROBE_DEST', {
      PROBE_ZIP: zip,
      PROBE_DEST: channel === 'stable' ? reference : dirname(executable)
    });
  }

  const stableTree = await snapshot(reference);
  const nightlyAsar = await fileHash(join(dirname(executable), 'resources', 'app.asar'));
  if (!stableTree['resources/app.asar'] || nightlyAsar === stableTree['resources/app.asar'])
    throw new Error('Package payloads must differ before updating.');
  const fixture = join(root, 'fixture-project');
  await writeFile(join(fixture, 'README.md'), 'Temporary public Windows updater fixture.\n', {
    flag: 'wx'
  });

  phase = 'start verified nightly';
  const first = await start(expected.nightlyVersion);
  const project = await deadline(
    first.page.evaluate(folder => window.aycode.addProject(folder), fixture),
    'Create fixture project'
  );
  if (!project?.id)
    throw new Error('Fixture project missing.');
  // Bootstrap the saved fixture through the normal renderer, outside controller state.
  await first.page.reload();

  phase = 'native Windows first start and navigation';
  const firstStartUi = await verifyWindowsShell(app, first.page, project, { firstStart: true });

  phase = 'regular channel switch';
  await deadline(first.page.evaluate(() => window.aycode.updateSettings({
    updates: {
      channel: 'nightly',
      autoCheck: false,
      autoDownload: false
    }
  })), 'Choose nightly channel');
  await deadline(first.page.evaluate(() => window.aycode.checkForUpdates()), 'Settle nightly check');
  const nightlyStatus = await until(
    () => first.page.evaluate(() => window.aycode.updateStatus()),
    value => value.channel === 'nightly' && !['idle', 'checking'].includes(value.state),
    'Nightly channel status'
  );
  if (nightlyStatus.state === 'error' || nightlyStatus.currentVersion !== expected.nightlyVersion)
    throw new Error('The normal nightly channel check failed.');
  await deadline(first.page.evaluate(() => window.aycode.updateSettings({
    updates: {
      channel: 'stable',
      autoCheck: false,
      autoDownload: false
    }
  })), 'Choose stable channel');
  await deadline(first.page.evaluate(() => window.aycode.checkForUpdates()), 'Regular update check');
  const offered = await until(
    () => first.page.evaluate(() => window.aycode.updateStatus()),
    value => !['idle', 'checking'].includes(value.state),
    'Stable offer'
  );
  checkUpdate(offered, expected, 'available');

  phase = 'regular signed download';
  const ready = await deadline(
    first.page.evaluate(() => window.aycode.downloadUpdate()),
    'Download and stage signed update',
    10 * 60_000
  );
  checkUpdate(ready, expected, 'ready');

  // Independent identity check only: never alter the updater's staged files or readiness metadata.
  const downloaded = join(
    environment.LOCALAPPDATA, 'AyCode-staging', 'updater', expected.stableVersion,
    `AyCode-${expected.stableVersion}-win-x64.zip`
  );
  if ((await fileHash(downloaded)) !== hashes.stable)
    throw new Error('Updater downloaded a different signed release.');

  phase = 'real install and automatic relaunch';
  const previous = app;
  const oldPid = first.pid;
  let installError;
  const mainIdentity = await observeMainIdentity(() => previous.evaluate((_electron, identity) => ({
    pidMatches: process.pid === identity.pid,
    executableMatches: process.execPath.toLowerCase() === identity.executable.toLowerCase(),
  }), { pid: oldPid, executable }));
  const installObserver = observeInstallRequest(first.page.evaluate(() => window.aycode.installUpdate()));
  installObservation = { observer: installObserver, child: previous.process(), pid: oldPid, mainIdentity };
  const install = installObserver.observeDeadline(deadline(installObserver.promise, 'Install request', 30_000)).catch(error => {
    installError = error;
  });
  await until(
    () => Promise.resolve(previous.process().exitCode),
    value => value !== null,
    'Original application exit',
    60_000
  );

  // Do not call _electron.launch/app.relaunch here: the shipped update helper must start the new PID itself.
  app = undefined;
  const observed = await until(
    () => processes(),
    items => items.some(item =>
      item.pid !== oldPid &&
      item.path.toLowerCase() === executable.toLowerCase() &&
      item.window !== 0 &&
      item.responding
    ),
    'Automatic replacement window',
    120_000
  );
  const started = observed.filter(item =>
    item.pid !== oldPid &&
    item.path.toLowerCase() === executable.toLowerCase() &&
    item.window !== 0 &&
    item.responding
  );
  if (started.length !== 1)
    throw new Error('Ambiguous automatic relaunch.');
  autoPid = started[0].pid;
  await install;
  // A closed Electron bridge is normal after a successful install; a still-open app already fails above.
  if (installError && !/closed|destroyed|Target|session/i.test(installError.message))
    throw installError;
  const installedTree = await snapshot(dirname(executable));
  if (JSON.stringify(installedTree) !== JSON.stringify(stableTree))
    throw new Error('Installed bytes differ from verified stable ZIP.');
  await delay(3_000);
  if (!processes().some(item => item.pid === autoPid && item.window !== 0 && item.responding))
    throw new Error('Automatically relaunched window did not stay alive.');
  const staging = join(environment.LOCALAPPDATA, 'AyCode-staging', 'updater', expected.stableVersion);
  const helperLog = await until(
    () => readFile(join(staging, 'helper.log'), 'utf8'),
    text => /(?:^|\r?\n)\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} updated(?:\r?\n|$)/.test(text),
    'Update helper completion',
    30_000
  );
  checkHelperLog(helperLog);
  const acknowledgement = await readFile(join(staging, 'helper.ready'));
  const acknowledged = (
    acknowledgement[0] === 0xff && acknowledgement[1] === 0xfe
      ? acknowledgement.toString('utf16le')
      : acknowledgement.toString('utf8')
  ).replace(/^\uFEFF/, '').trim();
  if (acknowledged !== 'ready')
    throw new Error('Update helper startup acknowledgement missing.');
  const automatic = {
    oldPid,
    newPid: autoPid,
    window: true,
    payloadTreeMatches: true,
    helperCompleted: true
  };

  // The helper intentionally does not inherit Playwright's launch switches. Keep this second proof distinct.

  phase = 'separate cold-start persistence verification';
  powerShell('$p = Get-Process -Id ([int]$env:PROBE_PID) -ErrorAction Stop; if ($p.Path -ne $env:PROBE_EXE) { throw "Process identity changed" }; [void]$p.CloseMainWindow()', {
    PROBE_PID: String(autoPid),
    PROBE_EXE: executable
  });
  await until(() => processes(), items => !items.some(item => item.pid === autoPid), 'Close automatic instance', 30_000);
  autoPid = undefined;
  const second = await start(expected.stableVersion);
  if (!second.boot.projects?.some(item => item.id === project.id && item.path === fixture))
    throw new Error('Project did not survive update.');
  if ((await readFile(join(fixture, 'README.md'), 'utf8')) !== 'Temporary public Windows updater fixture.\n')
    throw new Error('Fixture content changed.');
  let stableUi = {
    status: 'not-applicable',
    reason: 'The pre-release helper target 7.4.5 predates the 7.4.6 Windows UI.',
  };
  if (requiresStableUi(expected)) {
    phase = 'native Windows stable navigation after update';
    stableUi = await verifyWindowsShell(app, second.page, project);
  }
  await close();
  const proof = {
    ...expected,
    status: 'passed',
    finalReleaseProof: expected.proofKind === 'final-release',
    platform: 'win32',
    arch: 'x64',
    signedDownloads: true,
    regularStableChannel: true,
    freshStaging: true,
    automaticRelaunch: automatic,
    nativeUi: { firstStart: firstStartUi, afterUpdate: stableUi },
    postRelaunchColdStart: {
      version: expected.stableVersion,
      applicationPlatform: 'win32',
      engineReady: true,
      projectPreserved: true
    },
    payload: {
      beforeAsar: nightlyAsar,
      afterAsar: stableTree['resources/app.asar'],
      fileCount: Object.keys(stableTree).length
    },
    limitations: [
      ...(expected.proofKind === 'pre-release-helper'
        ? ['pre-release helper check only; the final 7.4.6 upgrade proof is still required']
        : []),
      'not a historical 7.0.0 updater test',
      'not an NSIS installation update test',
      'not Authenticode or SmartScreen verification',
      'not a rollback or interrupted-install test'
    ]
  };
  await writeFile(join(root, 'upgrade-proof.json'), JSON.stringify(proof, null, 2), {
    flag: 'wx'
  });
  console.log(`AYCODE_WINDOWS_UPGRADE_PROOF=${JSON.stringify(proof)}`);
} catch (error) {
  console.error(`Windows upgrade probe failed at ${phase}: ${installFailureClass(error)}`);
  process.exitCode = 1;
  if (installObservation) {
    await reportInstallFailure({
      root, executable, powerShell: ps, environment, pid: installObservation.pid,
      staging: join(environment.LOCALAPPDATA, 'AyCode-staging', 'updater', expected.stableVersion),
      userData: environment.AYCODE_USER_DATA,
    }, installObservation);
  }
} finally {
  if (app) {
    try {
      await close();
    } catch {
      process.exitCode = 1;
    }
  }
  if (autoPid) kill(autoPid);
  // Unique fixture installation path only; never touch another AyCode installation or any real profile.
  for (const process of processes()) kill(process.pid);
}
