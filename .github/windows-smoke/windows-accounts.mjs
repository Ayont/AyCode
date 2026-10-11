// Generic native blackbox test. No provider code, credentials or OAuth requests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, win32 } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const HOME_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'AYCODE_USER_DATA'];
const FORBIDDEN_ENV = /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|PRIVATE_KEY|API_KEY|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/i;

function within(root, file) {
  const part = win32.relative(root, file);
  return Boolean(part) && !part.startsWith('..\\') && part !== '..' && !win32.isAbsolute(part);
}

function samePath(left, right) {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function cmdQuoted(file) {
  if (!win32.isAbsolute(file) || /["%!\r\n\0]/.test(file))
    throw new Error('Fixture paths must be absolute and contain no cmd expansion characters.');
  return `"${file}"`;
}

async function bounded(promise, label, milliseconds = 30_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(read, accept, label, milliseconds = 15_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await bounded(Promise.resolve().then(read), label, Math.max(1, end - Date.now()));
    if (accept(value)) return value;
    await delay(150);
  }
  throw new Error(`${label} was not observed.`);
}

// Serialized into a standalone fixture, never imported into the application.
// The fake CLI does local file I/O only and intentionally has no network client.
function syntheticCli(config) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { spawn } = require('node:child_process');
  const readline = require('node:readline');
  const [provider, ...args] = process.argv.slice(2);
  const fail = message => { process.stderr.write(`${message}\n`); process.exit(91); };
  const equivalent = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const contained = file => {
    const part = path.relative(config.root, fs.realpathSync(file));
    return part && part !== '..' && !part.startsWith(`..${path.sep}`) && !path.isAbsolute(part);
  };
  if (process.platform !== 'win32' || !['claude', 'codex'].includes(provider))
    fail('Native fixture provider required.');
  for (const key of config.homeKeys)
    if (!process.env[key] || !contained(process.env[key])) fail('Unisolated fixture environment.');
  if (!equivalent(os.homedir(), config.home)) fail('Unexpected OS home.');
  if (Object.keys(process.env).some(key => new RegExp(config.forbiddenEnv, 'i').test(key)))
    fail('Unexpected sensitive environment key.');

  const accountDir = process.env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] ||
    path.join(config.home, provider === 'claude' ? '.claude' : '.codex');
  if (!contained(accountDir)) fail('Account folder escaped fixture.');
  const identityFile = path.join(accountDir, provider === 'claude' ? '.credentials.json' : 'auth.json');
  const record = mode => {
    fs.writeFileSync(path.join(config.evidence, `${provider}-${process.pid}.json`), JSON.stringify({
      nonce: config.nonce, provider, mode, pid: process.pid, parentPid: process.ppid, accountDir,
    }), { flag: 'wx' });
  };
  if (args[0] === '--descendant' && args.length === 1) {
    record('descendant');
    setInterval(() => {}, 1_000);
    // A failed test never leaves an indefinite fixture on a disposable runner.
    setTimeout(() => process.exit(98), 180_000);
    return;
  }
  const signature = args.join(' ');
  if (signature === '--version') {
    process.stdout.write('Synthetic account fixture 1.0.0\n');
    return;
  }
  const isLogin = signature === (provider === 'claude' ? 'auth login --claudeai' : 'login');
  const isStatus = signature === (provider === 'claude' ? 'auth status --json' : 'login status');
  const isLogout = signature === (provider === 'claude' ? 'auth logout' : 'logout');
  if (!isLogin && !isStatus && !isLogout) fail('Unrecognized synthetic command.');
  record(isLogin ? 'login' : isStatus ? 'status' : 'logout');
  if (isLogout) {
    fs.rmSync(identityFile, { force: true });
    return;
  }
  if (isStatus) {
    let identity;
    try { identity = JSON.parse(fs.readFileSync(identityFile, 'utf8')); }
    catch { identity = null; }
    const ready = identity?.fixtureOnly === true && identity.nonce === config.nonce;
    if (provider === 'claude') {
      process.stdout.write(JSON.stringify({ loggedIn: ready,
        ...(ready ? { email: `${identity.subject}@example.invalid`, subscriptionType: 'synthetic' } : {}) }));
    } else {
      process.stderr.write(ready ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
    }
    process.exitCode = ready ? 0 : 1;
    return;
  }
  const mode = fs.readFileSync(path.join(config.control, `${provider}.txt`), 'utf8').trim();
  if (mode === 'cancel') {
    spawn(process.execPath, [__filename, provider, '--descendant'], {
      env: process.env, stdio: 'ignore', windowsHide: true,
    });
  } else if (mode !== 'complete') {
    fail('Unknown synthetic login mode.');
  }
  process.stdout.write('Paste code here\n');
  const input = readline.createInterface({ input: process.stdin });
  input.once('line', line => {
    if (mode !== 'complete' || !/^(claude|codex)-[AB]$/.test(line) || !line.startsWith(provider + '-'))
      fail('Unexpected synthetic login input.');
    fs.writeFileSync(identityFile, JSON.stringify({ fixtureOnly: true, nonce: config.nonce, subject: line }), { flag: 'wx' });
    input.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(98), 180_000).unref();
}

/** Run once in a verified packaged application with a new, isolated profile. */
export async function verifyWindowsAccounts(app, page, fixtureRoot) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('Native Windows x64 is required; no simulated account proof.');
  if (!fixtureRoot || !win32.isAbsolute(fixtureRoot))
    throw new Error('An absolute isolated fixture root is required.');
  const root = await realpath(fixtureRoot);
  if (!samePath(root, fixtureRoot)) throw new Error('Fixture root must be canonical.');
  const runtime = await bounded(app.evaluate(({ app }) => {
    const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'AYCODE_USER_DATA'];
    return {
      platform: process.platform, packaged: app.isPackaged,
      home: process.getBuiltinModule('node:os').homedir(), userData: app.getPath('userData'),
      env: Object.fromEntries(keys.map(key => [key, process.env[key]])),
      unsafeEnvironment: Object.keys(process.env).some(key =>
        /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|PRIVATE_KEY|API_KEY|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/i.test(key)),
    };
  }), 'Read packaged process isolation');
  assert.equal(runtime.platform, 'win32');
  assert.equal(runtime.packaged, true, 'Only a packaged application is acceptable.');
  assert.equal(runtime.unsafeEnvironment, false, 'Application inherited a secret or execution override.');
  for (const key of HOME_KEYS) {
    const value = runtime.env[key];
    assert.ok(typeof value === 'string' && within(root, value), `${key} is not isolated.`);
    assert.ok(within(root, await realpath(value)), `${key} resolves outside fixture.`);
  }
  assert.ok(samePath(runtime.home, runtime.env.HOME) && samePath(runtime.home, runtime.env.USERPROFILE), 'OS home is not isolated.');
  assert.ok(samePath(runtime.userData, runtime.env.AYCODE_USER_DATA), 'App profile is not isolated.');
  const home = await realpath(runtime.home);
  const userData = await realpath(runtime.userData);
  const initial = await bounded(page.evaluate(() => window.aycode.listAccounts()), 'Initial account list');
  assert.ok(initial.every(account => account.isDefault), 'Account probe requires a fresh profile.');

  // The directory is new and its unpredictable name also identifies owned processes.
  const nonce = randomUUID();
  const fixture = join(root, `Synthetic account CLI ${nonce}`);
  const evidence = join(fixture, 'process evidence');
  const control = join(fixture, 'control');
  await mkdir(fixture);
  await mkdir(evidence);
  await mkdir(control);
  const program = join(fixture, 'synthetic account program.cjs');
  const config = { root, home, evidence, control, nonce, homeKeys: HOME_KEYS, forbiddenEnv: FORBIDDEN_ENV.source };
  await writeFile(program, `(${syntheticCli.toString()})(${JSON.stringify(config)});\n`, { flag: 'wx' });
  const wrappers = {};
  const defaults = {};
  for (const provider of ['claude', 'codex']) {
    const folder = join(home, provider === 'claude' ? '.claude' : '.codex');
    // Never replace even a pre-existing synthetic profile: caller must supply a new one.
    await mkdir(folder);
    const identity = join(folder, provider === 'claude' ? '.credentials.json' : 'auth.json');
    const settings = join(folder, provider === 'claude' ? 'settings.json' : 'config.toml');
    const original = JSON.stringify({ fixtureOnly: true, nonce, subject: `${provider}-standard` });
    const settingsBytes = provider === 'claude' ? '{"fixtureMarker":"shared-settings"}\n' : '# shared-settings\n';
    await writeFile(identity, original, { flag: 'wx' });
    await writeFile(settings, settingsBytes, { flag: 'wx' });
    await mkdir(join(folder, 'skills'));
    const skill = join(folder, 'skills', 'synthetic-marker.txt');
    await writeFile(skill, 'The standard fixture skill must survive account removal.\n', { flag: 'wx' });
    defaults[provider] = { folder, identity, original, settings, settingsBytes, skill };
    wrappers[provider] = join(fixture, `${provider} account fixture.cmd`);
    // Absolute paths intentionally avoid npm's %~dp0 shim optimization: this
    // reaches the application's real cmd.exe quoting/process-tree path.
    await writeFile(wrappers[provider], `@echo off\r\n${cmdQuoted(process.execPath)} ${cmdQuoted(program)} ${provider} %*\r\nexit /b %errorlevel%\r\n`, { flag: 'wx' });
    await writeFile(join(control, `${provider}.txt`), 'complete\n', { flag: 'wx' });
  }

  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error('Missing Windows system directory.');
  const ps = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const taskkill = join(systemRoot, 'System32', 'taskkill.exe');
  const commandEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERNAME|USERDOMAIN|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
  Object.assign(commandEnv, runtime.env);
  async function inspectPid(pid) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Invalid fixture PID.');
    const script = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
      'if ($p) { [pscustomobject]@{ pid = [int]$p.ProcessId; parentPid = [int]$p.ParentProcessId; name = $p.Name; ' +
      'commandLine = $p.CommandLine; created = $p.CreationDate.ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress } else { "null" }';
    const result = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: commandEnv, encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024,
    });
    return JSON.parse(result.stdout.trim());
  }
  const owned = processInfo => processInfo && typeof processInfo.commandLine === 'string' &&
    processInfo.commandLine.toLowerCase().includes(fixture.toLowerCase());
  async function records() {
    const values = [];
    for (const filename of await readdir(evidence)) {
      if (!/^(claude|codex)-\d+\.json$/.test(filename)) throw new Error('Unexpected evidence filename.');
      let value;
      try { value = JSON.parse(await readFile(join(evidence, filename), 'utf8')); }
      catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      assert.equal(value.nonce, nonce);
      assert.ok(within(root, value.accountDir));
      values.push(value);
    }
    return values;
  }
  const accounts = [];
  const proof = [];
  const eventKey = `__accountProbe_${nonce.replaceAll('-', '')}`;
  await bounded(page.evaluate(key => {
    const state = { log: [], unsubscribe: null };
    state.unsubscribe = window.aycode.onEvent(event => {
      if (event.type === 'account.login') state.log.push(event.state);
    });
    window[key] = state;
  }, eventKey), 'Subscribe to account login events');
  async function waitPhase(id, phase) {
    return until(() => page.evaluate(({ key, id }) => window[key].log.filter(item => item.accountId === id),
      { key: eventKey, id }), states => {
      if (states.some(state => state.phase === 'failed')) throw new Error(`Synthetic login failed for ${id}.`);
      return states.some(state => state.phase === phase && (phase !== 'waiting' || state.acceptsCode === true));
    }, `${id}: ${phase}`);
  }
  async function assertDefaults(provider) {
    const original = defaults[provider];
    assert.equal(await readFile(original.identity, 'utf8'), original.original, 'Standard identity was modified.');
    assert.equal(await readFile(original.settings, 'utf8'), original.settingsBytes, 'Standard settings were modified.');
    assert.equal(await readFile(original.skill, 'utf8'), 'The standard fixture skill must survive account removal.\n');
  }
  async function add(provider, label) {
    const account = await bounded(page.evaluate(({ provider, label }) => window.aycode.addAccount(provider, label), { provider, label }), 'Add synthetic account');
    assert.equal(account.providerId, provider);
    assert.equal(account.isDefault, false);
    assert.match(account.id, new RegExp(`^${provider}-[a-f0-9]{8}$`));
    accounts.push(account);
    await waitPhase(account.id, 'waiting');
    const record = await until(records, rows => rows.some(row => row.mode === 'login' && basename(row.accountDir) === account.id), 'Native CLI login');
    const login = record.find(row => row.mode === 'login' && basename(row.accountDir) === account.id);
    const expected = join(userData, 'accounts', provider, account.id);
    assert.ok(samePath(login.accountDir, expected), 'CLI did not receive the account-specific folder.');
    assert.ok(within(root, await realpath(login.accountDir)));
    return { account, login, dir: login.accountDir };
  }
  try {
    for (const provider of ['claude', 'codex']) {
      const patch = { cliPath: wrappers[provider], ...(provider === 'codex' ? { installationMethod: 'native-windows' } : {}) };
      const settings = await bounded(page.evaluate(({ provider, patch }) => window.aycode.updateProviderSettings(provider, patch), { provider, patch }), 'Configure synthetic CLI');
      assert.equal(settings.fields.find(field => field.key === 'cliPath')?.value, wrappers[provider]);
      const pair = [];
      for (const letter of ['A', 'B']) {
        const current = await add(provider, `Synthetic ${letter}`);
        const standard = defaults[provider];
        const identityName = basename(standard.identity);
        await assert.rejects(lstat(join(current.dir, identityName)), { code: 'ENOENT' }, 'Standard identity was copied into an extra account.');
        assert.ok((await lstat(join(current.dir, 'skills'))).isSymbolicLink(), 'Windows shared skills must be a junction.');
        assert.ok(samePath(await realpath(join(current.dir, 'skills')), await realpath(join(standard.folder, 'skills'))));
        assert.equal(await readFile(join(current.dir, basename(standard.settings)), 'utf8'), standard.settingsBytes);
        assert.equal((await lstat(join(current.dir, basename(standard.settings)))).isSymbolicLink(), false);
        await bounded(page.evaluate(({ id, code }) => window.aycode.submitAccountCode(id, code),
          { id: current.account.id, code: `${provider}-${letter}` }), 'Complete synthetic login');
        await waitPhase(current.account.id, 'done');
        const list = await bounded(page.evaluate(() => window.aycode.listAccounts()), 'Read synthetic accounts');
        assert.equal(list.find(account => account.id === current.account.id)?.status, 'ready');
        const identity = JSON.parse(await readFile(join(current.dir, identityName), 'utf8'));
        assert.deepEqual(identity, { fixtureOnly: true, nonce, subject: `${provider}-${letter}` });
        const statusRows = await records();
        assert.ok(statusRows.some(row => row.mode === 'status' && samePath(row.accountDir, current.dir)), 'Native status command did not run.');
        await assertDefaults(provider);
        pair.push(current);
      }
      assert.notEqual((await realpath(pair[0].dir)).toLowerCase(), (await realpath(pair[1].dir)).toLowerCase());
      await writeFile(join(pair[0].dir, basename(defaults[provider].settings)), '# synthetic account A edit\n');
      assert.equal(await readFile(join(pair[1].dir, basename(defaults[provider].settings)), 'utf8'), defaults[provider].settingsBytes);
      await assertDefaults(provider);

      await writeFile(join(control, `${provider}.txt`), 'cancel\n');
      const pending = await add(provider, 'Synthetic cancelled');
      const rows = await until(records, values => values.some(row => row.mode === 'descendant' && samePath(row.accountDir, pending.dir)), 'Live login descendant');
      const descendant = rows.find(row => row.mode === 'descendant' && samePath(row.accountDir, pending.dir));
      assert.equal(descendant.parentPid, pending.login.pid);
      const processTree = [];
      for (const pid of [pending.login.parentPid, pending.login.pid, descendant.pid]) {
        const processInfo = await inspectPid(pid);
        assert.ok(owned(processInfo), 'Expected live owned fixture process was not observed.');
        processTree.push(processInfo);
      }
      assert.equal(processTree[0].name.toLowerCase(), 'cmd.exe', 'The real Windows .cmd path was bypassed.');
      assert.equal(processTree[1].parentPid, processTree[0].pid);
      await bounded(page.evaluate(id => window.aycode.cancelAccountLogin(id), pending.account.id), 'Cancel synthetic login');
      await waitPhase(pending.account.id, 'cancelled');
      for (const previous of processTree) {
        await until(() => inspectPid(previous.pid), current => !current || current.created !== previous.created,
          `Native cancellation of ${previous.name}`, 15_000);
      }
      await assert.rejects(lstat(join(pending.dir, basename(defaults[provider].identity))), { code: 'ENOENT' });
      await assertDefaults(provider);

      // Remove A while B still exists: junction removal must leave the shared
      // source intact, and logout must affect only A's synthetic credentials.
      for (const current of [pair[0], pending, pair[1]]) {
        await bounded(page.evaluate(id => window.aycode.removeAccount(id), current.account.id), 'Remove synthetic account');
        await assert.rejects(lstat(current.dir), { code: 'ENOENT' });
        assert.ok((await records()).some(row => row.mode === 'logout' && samePath(row.accountDir, current.dir)));
        await assertDefaults(provider);
        if (current === pair[0]) {
          const other = JSON.parse(await readFile(join(pair[1].dir, basename(defaults[provider].identity)), 'utf8'));
          assert.equal(other.subject, `${provider}-B`);
        }
      }
      proof.push({ provider, nativeCmdWithSpaces: true, statusCommand: true, isolatedAccounts: 2,
        unchangedStandardFixture: true, sharedSkillsJunction: true, copiedSettings: true,
        cancelledProcessTree: processTree.map(({ name }) => name), logoutIsolation: true, junctionRemoval: true });
    }
    const final = await bounded(page.evaluate(() => window.aycode.listAccounts()), 'Final account list');
    assert.ok(final.every(account => account.isDefault));
    const result = { syntheticCli: true, providers: proof, realProviderAuthentication: false,
      accountChatRouting: false, statusTimeoutTreeKill: false, windowsCredentialManager: false };
    await writeFile(join(fixture, 'proof.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return result;
  } finally {
    // Cleanup is never accepted as cancellation proof: all assertions above
    // happen first. Only our exact fixture command lines can be terminated.
    for (const account of accounts)
      await bounded(page.evaluate(id => window.aycode.cancelAccountLogin(id), account.id), 'Cleanup login', 3_000).catch(() => {});
    const cleanupPids = new Set((await records().catch(() => []))
      .filter(row => row.mode === 'login' || row.mode === 'descendant')
      .flatMap(row => [row.pid, row.parentPid]));
    for (const pid of cleanupPids) {
      const current = await inspectPid(pid).catch(() => null);
      if (owned(current)) await execute(taskkill, ['/PID', String(pid), '/T', '/F'], {
        env: commandEnv, timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024,
      }).catch(() => {});
    }
    await bounded(page.evaluate(key => { window[key]?.unsubscribe(); delete window[key]; }, eventKey),
      'Unsubscribe account probe', 3_000).catch(() => {});
  }
}
