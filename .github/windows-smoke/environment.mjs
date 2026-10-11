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
  return { ...environment,
    HOME: win32.join(fixtureRoot, 'home'), USERPROFILE: win32.join(fixtureRoot, 'home'),
    APPDATA: win32.join(fixtureRoot, 'roaming'), LOCALAPPDATA: win32.join(fixtureRoot, 'local'),
    TEMP: win32.join(fixtureRoot, 'temp'), TMP: win32.join(fixtureRoot, 'temp'),
    AYCODE_USER_DATA: win32.join(fixtureRoot, 'user-data'), AYCODE_MOBILE_PORT: '0',
  };
}
