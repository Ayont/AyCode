import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { cleanEnvironment } from './environment.mjs';

const root = 'D:\\isolated test\\zip-profile';
test('application profiles replace every inherited home variant and reject CI execution credentials', () => {
  const env = cleanEnvironment({
    Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    hOmE: 'C:\\real home', UserProfile: 'C:\\real profile', APPDATA: 'C:\\real roaming',
    localappdata: 'C:\\real local', TeMp: 'C:\\real temp', tmp: 'C:\\real tmp',
    AYCODE_USER_DATA: 'C:\\real app', GH_TOKEN: 'fixture-not-a-secret', Github_Token: 'fixture',
    NODE_OPTIONS: '--require bad.cjs', electron_run_as_node: '1', CLAUDE_CONFIG_DIR: 'C:\\real claude',
    CODEX_HOME: 'C:\\real codex', AYCODE_MOBILE_PORT: '9999', UNRELATED: 'not allowed',
  }, root);
  assert.equal(env.PATH, 'C:\\Windows\\System32');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(env.HOME, win32.join(root, 'home'));
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.APPDATA, win32.join(root, 'roaming'));
  assert.equal(env.LOCALAPPDATA, win32.join(root, 'local'));
  assert.equal(env.TEMP, win32.join(root, 'temp'));
  assert.equal(env.TMP, env.TEMP);
  assert.equal(env.AYCODE_USER_DATA, win32.join(root, 'user-data'));
  assert.equal(env.AYCODE_MOBILE_PORT, '0');
  assert.equal(Object.keys(env).length, 11);
  assert.equal(new Set(Object.keys(env).map(key => key.toUpperCase())).size, Object.keys(env).length);
});

test('ZIP, NSIS installer and installed app profiles never share mutable home or application directories', () => {
  const source = { PATH: 'C:\\Windows', TEMP: 'C:\\real temp' };
  const first = cleanEnvironment(source, root);
  const second = cleanEnvironment(first, 'D:\\isolated test\\installed-profile');
  const third = cleanEnvironment(source, 'D:\\isolated test\\installer-profile');
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'AYCODE_USER_DATA']) {
    assert.equal(new Set([first[key], second[key], third[key]]).size, 3);
  }
  assert.deepEqual(cleanEnvironment(first, root), first);
  assert.equal(source.TEMP, 'C:\\real temp');
});

test('isolation requires an absolute non-root Windows directory', () => {
  for (const value of [undefined, '', '.', 'D:', 'D:\\', '\\relative'])
    assert.throws(() => cleanEnvironment({}, value), /isolated/);
});
