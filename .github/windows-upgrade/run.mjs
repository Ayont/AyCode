import { _electron } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, win32 } from 'node:path';
import { inputs, cleanEnvironment, signedManifest, checkSource, checkUpdate, checkHelperLog, requiresStableUi, upgradeRoute, checkReviewHandoff,
  installationMode, checkNsisHost, signedAssetHash, checkAssetBytes, checkNsisTree, checkNsisRegistration,
  NSIS_PRODUCT_GUID, checkNsisFreshRegistration, nsisRegistrationObservation,
  NSIS_PHASES, isNsisPhase, nsisDiagnosticObservation, nsisTreeObservation } from './verify.mjs';
import { verifyWindowsShell } from './windows-ui.mjs';
import { installFailureClass, observeInstallRequest, observeMainIdentity, reportInstallFailure,
  verifiedMainPid, nativePidState, replacementWindows } from './install-diagnostics.mjs';
import { startObserver } from './helper-events.mjs';
import { UPDATE_PHASES, isUpdatePhase, reportUpdateFailure } from './update-diagnostics.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Native Windows x64 required.');
const expected = inputs(process.env);
const route = upgradeRoute(expected);
const nsis = installationMode(expected) === 'nsis';
const startVersion = expected[route.start + 'Version'];
const targetVersion = expected[route.target + 'Version'];
const root = process.env.AYCODE_UPGRADE_ROOT;
if (!root || !win32.isAbsolute(root))
  throw new Error('Missing isolated absolute workspace.');
if (nsis) {
  checkNsisHost(process.env, root);
  if ((await lstat(root)).isSymbolicLink() || (await realpath(root)).toLowerCase() !== win32.normalize(root).toLowerCase())
    throw new Error('NSIS workspace must not redirect outside its disposable directory.');
}
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
const reference = join(root, 'target reference');
const startReference = join(root, 'start reference');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app,
  autoPid,
  installObservation,
  helperEvents,
  installer,
  installerEvidence,
  nsisExtras,
  registrationBefore,
  registrationAfter,
  updatePage,
  lastUpdateStatus,
  nsisInstallerStarted,

  phase = 'package verification';
const nsisObservation = { installer: { state: 'not-started' } };

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

function existingNsisRegistration() {
  // Check every product key before running an installer: filtering by the new
  // path would miss an existing installation that NSIS could otherwise remove.
  return JSON.parse(powerShell(`
$checked = 0; $present = 0
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      foreach ($path in @('Software\\${NSIS_PRODUCT_GUID}', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_PRODUCT_GUID}')) {
        $key = $base.OpenSubKey($path, $false)
        $checked++
        if ($null -ne $key) { $present++; $key.Dispose() }
      }
    } finally { $base.Dispose() }
  }
}
@{checkedKeys=$checked; presentKeys=$present} | ConvertTo-Json -Compress`));
}

function nsisRegistration() {
  // Read only the fixed per-user x64 product entry. Its commands must name the
  // synthetic installation exactly; no raw registry strings enter diagnostics.
  return JSON.parse(powerShell(`
$uninstaller = [IO.Path]::Combine($env:PROBE_INSTALL, 'Uninstall AyCode.exe')
$quoted = '"' + $uninstaller + '"'
$result = @{count=0; key=''; displayVersion=''; uninstallMatches=$false; quietUninstallMatches=$false; uninstallerExists=$false; installLocationMatches=$false}
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
try {
  $key = $base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_PRODUCT_GUID}', $false)
  if ($null -ne $key) {
    try {
      $result.count = 1
      $result.key = '${NSIS_PRODUCT_GUID}'
      $result.displayVersion = [string]$key.GetValue('DisplayVersion', '')
      $result.uninstallMatches = [string]::Equals([string]$key.GetValue('UninstallString', ''), $quoted + ' /currentuser', [StringComparison]::OrdinalIgnoreCase)
      $result.quietUninstallMatches = [string]::Equals([string]$key.GetValue('QuietUninstallString', ''), $quoted + ' /currentuser /S', [StringComparison]::OrdinalIgnoreCase)
      $result.uninstallerExists = [IO.File]::Exists($uninstaller)
    } finally { $key.Dispose() }
  }
  $installKey = $base.OpenSubKey('Software\\${NSIS_PRODUCT_GUID}', $false)
  if ($null -ne $installKey) {
    try {
      $result.installLocationMatches = [string]::Equals([string]$installKey.GetValue('InstallLocation', ''), $env:PROBE_INSTALL, [StringComparison]::OrdinalIgnoreCase)
    } finally { $installKey.Dispose() }
  }
} finally { $base.Dispose() }
$result | ConvertTo-Json -Compress`, { PROBE_INSTALL: dirname(executable) }));
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
  // Playwright's Windows ChildProcess is a shell wrapper, not Electron's main process.
  const identity = await deadline(app.evaluate((_electron, expectedExe) => ({
    pid: process.pid,
    executableMatches: process.execPath.toLowerCase() === expectedExe.toLowerCase(),
  }), executable), 'Packaged main process identity');
  return {
    page,
    boot,
    pid: verifiedMainPid(identity)
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
    if (nsis && channel === route.start) {
      const name = `AyCode-Setup-${version}-win-x64.exe`;
      const record = JSON.parse(await readFile(join(directory, 'verified.json'), 'utf8')).packages?.[name];
      signedAssetHash(record, name, manifest);
      const file = join(directory, name);
      const stat = await lstat(file);
      if (!stat.isFile()) throw new Error('Verified installer must be a regular file.');
      checkAssetBytes(record, stat.size, await fileHash(file));
      installerEvidence = { name, sha256: manifest.get(name), size: stat.size };
    }
    powerShell('Expand-Archive -LiteralPath $env:PROBE_ZIP -DestinationPath $env:PROBE_DEST', {
      PROBE_ZIP: zip,
      PROBE_DEST: channel === route.target ? reference : nsis ? startReference : dirname(executable)
    });
  }

  const targetTree = await snapshot(reference);
  if (nsis) {
    phase = NSIS_PHASES.validateHost;
    // No installer runs outside the explicit disposable workflow. /S suppresses
    // oneClick runAfterFinish; never pass --force-run. /D must be last/unquoted.
    checkNsisHost(process.env, root);
    phase = NSIS_PHASES.readExistingRegistration;
    nsisObservation.registration = existingNsisRegistration();
    phase = NSIS_PHASES.validateFreshRegistration;
    checkNsisFreshRegistration(nsisObservation.registration);
    phase = NSIS_PHASES.beforeProcesses;
    nsisObservation.beforeProcesses = processes().length;
    if (nsisObservation.beforeProcesses !== 0)
      throw new Error('Synthetic NSIS installation is not fresh.');
    phase = NSIS_PHASES.verifyInstaller;
    const setup = join(root, route.start, installerEvidence.name);
    const setupStat = await lstat(setup);
    if (!setupStat.isFile()) throw new Error('Verified installer must remain a regular file.');
    checkAssetBytes({ size: installerEvidence.size, digest: `sha256:${installerEvidence.sha256}` },
      setupStat.size, await fileHash(setup));
    phase = NSIS_PHASES.startInstaller;
    nsisInstallerStarted = performance.now();
    installer = spawn(setup, ['/S', `/D=${dirname(executable)}`], {
      env: environment, cwd: join(root, route.start), windowsHide: true,
      windowsVerbatimArguments: true, stdio: 'ignore'
    });
    nsisObservation.installer = { state: 'pending' };
    phase = NSIS_PHASES.waitInstaller;
    const exit = await deadline(new Promise((resolve, reject) => {
      installer.once('error', error => {
        nsisObservation.installer = { state: 'spawn-error', elapsedMs: Math.round(performance.now() - nsisInstallerStarted) };
        reject(error);
      });
      installer.once('exit', (code, signal) => {
        nsisObservation.installer = { state: 'exited', exitCode: code, signal,
          elapsedMs: Math.round(performance.now() - nsisInstallerStarted) };
        resolve(code);
      });
    }), 'NSIS installer', 120_000);
    installer = undefined;
    phase = NSIS_PHASES.validateExit;
    if (exit !== 0) throw new Error('NSIS installation failed.');
    phase = NSIS_PHASES.afterProcesses;
    nsisObservation.afterProcesses = processes().length;
    if (nsisObservation.afterProcesses !== 0) throw new Error('Silent NSIS unexpectedly started the application.');
    phase = NSIS_PHASES.readTree;
    const installedTree = await snapshot(dirname(executable));
    const initialReference = await snapshot(startReference);
    phase = NSIS_PHASES.validateTree;
    nsisObservation.tree = nsisTreeObservation(installedTree, initialReference);
    nsisExtras = checkNsisTree(installedTree, initialReference);
    phase = NSIS_PHASES.readRegistration;
    registrationBefore = nsisRegistration();
    console.log(`AYCODE_NSIS_BEFORE=${JSON.stringify(nsisRegistrationObservation(registrationBefore, startVersion, targetVersion))}`);
    phase = NSIS_PHASES.validateRegistration;
    checkNsisRegistration(registrationBefore, startVersion);
  }
  phase = 'verify starting payload identity';
  const startAsar = await fileHash(join(dirname(executable), 'resources', 'app.asar'));
  if (!targetTree['resources/app.asar'] || startAsar === targetTree['resources/app.asar'])
    throw new Error('Package payloads must differ before updating.');
  phase = 'create synthetic project fixture';
  const fixture = join(root, 'fixture-project');
  await writeFile(join(fixture, 'README.md'), 'Temporary public Windows updater fixture.\n', {
    flag: 'wx'
  });

  phase = 'start verified ' + (route.review ? 'review payload' : 'nightly');
  const first = await start(startVersion);
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

  updatePage = first.page;
  if (!route.review) {
    phase = UPDATE_PHASES.chooseNightly;
    await deadline(first.page.evaluate(() => window.aycode.updateSettings({
      updates: { channel: 'nightly', autoCheck: false, autoDownload: false }
    })), 'Choose nightly channel');
    phase = UPDATE_PHASES.checkNightly;
    lastUpdateStatus = await deadline(first.page.evaluate(() => window.aycode.checkForUpdates()), 'Settle nightly check');
    phase = UPDATE_PHASES.observeNightly;
    const nightlyStatus = await until(
      async () => (lastUpdateStatus = await first.page.evaluate(() => window.aycode.updateStatus())),
      value => value.channel === 'nightly' && !['idle', 'checking'].includes(value.state),
      'Nightly channel status'
    );
    phase = UPDATE_PHASES.validateNightly;
    if (nightlyStatus.state === 'error' || nightlyStatus.currentVersion !== startVersion)
      throw new Error('The normal nightly channel check failed.');
  }
  phase = UPDATE_PHASES.chooseTarget;
  await deadline(first.page.evaluate(channel => window.aycode.updateSettings({
    updates: { channel, autoCheck: false, autoDownload: false }
  }), route.target), 'Choose target channel');
  phase = UPDATE_PHASES.checkTarget;
  lastUpdateStatus = await deadline(first.page.evaluate(() => window.aycode.checkForUpdates()), 'Regular update check');
  phase = UPDATE_PHASES.observeTarget;
  const offered = await until(
    async () => (lastUpdateStatus = await first.page.evaluate(() => window.aycode.updateStatus())),
    value => !['idle', 'checking'].includes(value.state),
    'Exact target offer'
  );
  phase = UPDATE_PHASES.validateTarget;
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
    environment.LOCALAPPDATA, 'AyCode-staging', 'updater', targetVersion,
    `AyCode-${targetVersion}-win-x64.zip`
  );
  if ((await fileHash(downloaded)) !== hashes[route.target])
    throw new Error('Updater downloaded a different signed release.');

  phase = 'real install and automatic relaunch';
  const previous = app;
  const oldPid = first.pid;
  let installError;
  const mainIdentity = await observeMainIdentity(() => previous.evaluate(({ app }, identity) => ({
    pidMatches: process.pid === identity.pid,
    executableMatches: process.execPath.toLowerCase() === identity.executable.toLowerCase(),
    appExeMatches: app.getPath('exe').toLowerCase() === identity.executable.toLowerCase(),
    userDataMatches: app.getPath('userData').toLowerCase() === identity.userData.toLowerCase(),
    localAppDataMatches: process.env.LOCALAPPDATA?.toLowerCase() === identity.localAppData.toLowerCase(),
    envUserDataMatches: process.env.AYCODE_USER_DATA?.toLowerCase() === identity.userData.toLowerCase(),
  }), { pid: oldPid, executable, userData: environment.AYCODE_USER_DATA, localAppData: environment.LOCALAPPDATA }));
  phase = 'start read-only helper observer';
  helperEvents = await startObserver({ realPid: oldPid, systemPS: ps, cleanEnv: environment, syntheticRoot: root });
  if (helperEvents.snapshot().state !== 'waiting' || helperEvents.snapshot().ready !== true)
    throw new Error('Helper process observer is not ready.');
  phase = 'real install and automatic relaunch';
  const installObserver = observeInstallRequest(first.page.evaluate(() => window.aycode.installUpdate()));
  installObservation = { observer: installObserver, child: previous.process(), pid: oldPid, mainIdentity };
  const install = installObserver.observeDeadline(deadline(installObserver.promise, 'Install request', 30_000)).catch(error => {
    installError = error;
  });
  await until(
    () => Promise.resolve(nativePidState(oldPid)),
    value => value === 'absent',
    'Original application exit',
    60_000
  );

  // Do not call _electron.launch/app.relaunch here: the shipped update helper must start the new PID itself.
  app = undefined;
  const observed = await until(
    () => processes(),
    items => replacementWindows(items, oldPid, executable).length > 0,
    'Automatic replacement window',
    120_000
  );
  const started = replacementWindows(observed, oldPid, executable);
  if (started.length !== 1)
    throw new Error('Ambiguous automatic relaunch.');
  autoPid = started[0].pid;
  await install;
  // A closed Electron bridge is normal after a successful install; a still-open app already fails above.
  if (installError && !/closed|destroyed|Target|session/i.test(installError.message))
    throw installError;
  const installedTree = await snapshot(dirname(executable));
  if (nsis) {
    registrationAfter = nsisRegistration();
    console.log(`AYCODE_NSIS_AFTER=${JSON.stringify(nsisRegistrationObservation(registrationAfter, startVersion, targetVersion, registrationBefore.key))}`);
    checkNsisTree(installedTree, targetTree, nsisExtras);
    checkNsisRegistration(registrationAfter, targetVersion, registrationBefore.key);
  } else if (JSON.stringify(installedTree) !== JSON.stringify(targetTree))
    throw new Error('Installed bytes differ from verified target ZIP.');
  await delay(3_000);
  if (!processes().some(item => item.pid === autoPid && item.window !== 0 && item.responding))
    throw new Error('Automatically relaunched window did not stay alive.');
  const staging = join(environment.LOCALAPPDATA, 'AyCode-staging', 'updater', targetVersion);
  let helperDirectory = staging;
  if (route.review) {
    // The target's startup removes its version directory. The corrected helper
    // keeps its own handoff outside that directory until it has finished.
    const attempts = (await readdir(dirname(staging), { withFileTypes: true })).filter(entry => entry.name.startsWith('helper-launch-'));
    if (attempts.length !== 1 || !attempts[0].isDirectory()) throw new Error('Expected one isolated helper launch attempt.');
    helperDirectory = join(dirname(staging), attempts[0].name);
    const marker = async name => {
      const file = join(helperDirectory, name);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size !== 64) throw new Error('Invalid helper marker file.');
      return readFile(file, 'utf8');
    };
    const exists = async name => {
      try { await lstat(join(helperDirectory, name)); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    checkReviewHandoff({ ready: await marker('helper.ready'), commit: await marker('helper.commit'),
      cancelExists: await exists('helper.cancel'), pendingExists: await exists('helper.commit.pending') });
  } else {
    const acknowledgement = await readFile(join(helperDirectory, 'helper.ready'));
    const acknowledged = (
      acknowledgement[0] === 0xff && acknowledgement[1] === 0xfe
        ? acknowledgement.toString('utf16le')
        : acknowledgement.toString('utf8')
    ).replace(/^\uFEFF/, '').trim();
    if (acknowledged !== 'ready') throw new Error('Update helper startup acknowledgement missing.');
  }
  const helperLog = await until(
    () => readFile(join(helperDirectory, 'helper.log'), 'utf8'),
    text => /(?:^|\r?\n)\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} updated(?:\r?\n|$)/.test(text),
    'Update helper completion', 30_000
  );
  checkHelperLog(helperLog);
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
  const second = await start(targetVersion);
  if (!second.boot.projects?.some(item => item.id === project.id && item.path === fixture))
    throw new Error('Project did not survive update.');
  if ((await readFile(join(fixture, 'README.md'), 'utf8')) !== 'Temporary public Windows updater fixture.\n')
    throw new Error('Fixture content changed.');
  let targetUi = {
    status: 'not-applicable',
    reason: 'The pre-release helper target 7.4.5 predates the 7.4.6 Windows UI.',
  };
  if (requiresStableUi(expected)) {
    phase = 'native Windows target navigation after update';
    targetUi = await verifyWindowsShell(app, second.page, project);
  }
  await close();
  const proof = {
    ...expected,
    status: 'passed',
    finalReleaseProof: expected.proofKind === 'final-release',
    platform: 'win32',
    arch: 'x64',
    signedDownloads: true,
    regularStableChannel: !route.review,
    regularNightlyUpgrade: route.review,
    reviewUpdaterProof: route.review,
    installationMode: nsis ? 'nsis' : 'zip',
    ...(nsis ? { nsis: {
      installer: installerEvidence, silent: true, installerDidNotStartApp: true,
      initialPayloadMatchesZip: true, uninstallerFilesPreserved: true,
      preservedFiles: Object.keys(nsisExtras),
      registration: { sameEntry: true, uninstallerExists: true, installLocationMatches: true,
        displayVersionBefore: registrationBefore.displayVersion, displayVersionAfter: registrationAfter.displayVersion }
    } } : {}),
    freshStaging: true,
    automaticRelaunch: automatic,
    nativeUi: { firstStart: firstStartUi, afterUpdate: targetUi },
    postRelaunchColdStart: {
      version: targetVersion,
      applicationPlatform: 'win32',
      engineReady: true,
      projectPreserved: true
    },
    payload: {
      beforeAsar: startAsar,
      afterAsar: targetTree['resources/app.asar'],
      fileCount: Object.keys(targetTree).length
    },
    limitations: [
      ...(route.review ? ['tests corrected review updater only; published stable and target nightly still contain their original updater'] : []),
      ...(expected.proofKind === 'pre-release-helper'
        ? ['pre-release helper check only; the final 7.4.6 upgrade proof is still required']
        : []),
      'not a historical 7.0.0 updater test',
      ...(nsis ? ['per-user silent NSIS on disposable Windows 2025 only; uninstallation was not executed'] : ['not an NSIS installation update test']),
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
  if (isNsisPhase(phase)) {
    if (nsisObservation.installer.state === 'pending')
      nsisObservation.installer.elapsedMs = Math.round(performance.now() - nsisInstallerStarted);
    try { console.error(`AYCODE_NSIS_DIAGNOSTIC=${JSON.stringify(nsisDiagnosticObservation({ ...nsisObservation, phase, error }))}`); }
    catch { /* Diagnosis must not replace the original NSIS failure. */ }
  }
  if (isUpdatePhase(phase)) {
    await reportUpdateFailure({ phase, error, lastStatus: lastUpdateStatus,
      readStatus: () => updatePage.evaluate(() => window.aycode.updateStatus()),
      versions: { startVersion, targetVersion } });
  }
  if (installObservation) {
    await reportInstallFailure({
      root, executable, powerShell: ps, environment, pid: installObservation.pid,
      staging: join(environment.LOCALAPPDATA, 'AyCode-staging', 'updater', targetVersion),
      userData: environment.AYCODE_USER_DATA,
    }, installObservation);
  }
} finally {
  if (installer) kill(installer.pid);
  if (helperEvents) {
    console.error(`AYCODE_HELPER_EVENT_DIAGNOSTIC=${JSON.stringify(helperEvents.snapshot())}`);
    try { await helperEvents.dispose(); }
    catch { console.error('AYCODE_HELPER_EVENT_DIAGNOSTIC={"state":"cleanup-error"}'); }
  }
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
