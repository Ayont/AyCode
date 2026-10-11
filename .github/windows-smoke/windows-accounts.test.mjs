import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessExists } from './windows-accounts.mjs';

test('native termination probe treats only ESRCH as a process exit', () => {
  assert.equal(fixtureProcessExists(123, (pid, signal) => {
    assert.equal(pid, 123); assert.equal(signal, 0); return true;
  }), true);
  assert.equal(fixtureProcessExists(123, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  assert.equal(fixtureProcessExists(123, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), true);
  assert.throws(() => fixtureProcessExists(123, () => { throw Object.assign(new Error('unexpected'), { code: 'EIO' }); }), /unexpected/);
  for (const pid of [0, -1, 1.5, NaN, '123']) assert.throws(() => fixtureProcessExists(pid), /Invalid fixture PID/);
});
