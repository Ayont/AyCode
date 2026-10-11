import { win32 } from 'node:path';

const systemNames = new Map(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec',
  'USERNAME', 'USERDOMAIN', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']
  .map(key => [key.toUpperCase(), key]));

// Windows environment names are case-insensitive. Reconstructing the allowlist
// prevents differently-cased inherited homes or credentials from shadowing it.
export function cleanEnvironment(source, fixtureRoot) {
  if (typeof fixtureRoot !== 'string' || !/^[a-z]:[\\/]/i.test(fixtureRoot) ||
      !win32.isAbsolute(fixtureRoot) || win32.normalize(fixtureRoot) === win32.parse(fixtureRoot).root)
    throw new Error('An isolated absolute Windows directory is required.');
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    const name = systemNames.get(key.toUpperCase());
    if (name && typeof value === 'string') environment[name] = value;
  }
  const home = win32.join(fixtureRoot, 'home');
  const local = win32.join(home, 'AppData', 'Local');
  return { ...environment,
    HOME: home, USERPROFILE: home,
    // Known Folder APIs expand USERPROFILE; match their normal directory layout.
    APPDATA: win32.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: local,
    TEMP: win32.join(local, 'Temp'), TMP: win32.join(local, 'Temp'),
    AYCODE_USER_DATA: win32.join(fixtureRoot, 'user-data'), AYCODE_MOBILE_PORT: '0',
  };
}
