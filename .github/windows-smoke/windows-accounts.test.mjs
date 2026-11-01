import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMissingLogout, fixtureProcessExists, isEvidenceFilename, isFaultFilename } from './windows-accounts.mjs';

test('native termination probe treats only ESRCH as a process exit', () => {
  assert.equal(fixtureProcessExists(123, (pid, signal) => {
    assert.equal(pid, 123); assert.equal(signal, 0); return true;
  }), true);
  assert.equal(fixtureProcessExists(123, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  assert.equal(fixtureProcessExists(123, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), true);
  assert.throws(() => fixtureProcessExists(123, () => { throw Object.assign(new Error('unexpected'), { code: 'EIO' }); }), /unexpected/);
  for (const pid of [0, -1, 1.5, NaN, '123']) assert.throws(() => fixtureProcessExists(pid), /Invalid fixture PID/);
});

// Windows hands a freed process ID to the next process within moments. Evidence named by the ID alone and
// created exclusively would then crash the later fixture before it leaves its record.
test('fixture evidence and crash notes carry a random part next to the process ID', () => {
  assert.equal(isEvidenceFilename('claude-4242-0123456789ab.json'), true);
  assert.equal(isEvidenceFilename('codex-7-abcdefabcdef.json'), true);
  for (const name of ['claude-4242.json', 'claude-4242-0123456789AB.json', 'claude-4242-0123.json', 'other-4242-0123456789ab.json',
    '../claude-4242-0123456789ab.json', 'claude-4242-0123456789ab.json.tmp', 'claude--0123456789ab.json', 'claude-4242-0123456789ab.txt'])
    assert.equal(isEvidenceFilename(name), false, name);
  assert.equal(isFaultFilename('claude-4242-0123456789ab.txt'), true);
  for (const name of ['claude-4242-0123456789ab.json', 'claude-4242.txt', 'x-4242-0123456789ab.txt'])
    assert.equal(isFaultFilename(name), false, name);
});

test('a missing logout record explains itself', () => {
  const message = describeMissingLogout({
    account: 'claude-1a2b3c4d', removalMs: 240,
    rows: [
      { mode: 'login', pid: 11, accountDir: 'D:\\root\\accounts\\claude\\claude-1a2b3c4d' },
      { mode: 'status', pid: 12, accountDir: 'D:\\root\\x' },
    ],
    faults: [{ file: 'claude-12-0123456789ab.txt', text: 'Error: EEXIST' }],
    notices: ['Sign-out failed for A'],
  });
  assert.match(message, /^No logout record for claude-1a2b3c4d after a 240 ms removal: /);
  const detail = JSON.parse(message.slice(message.indexOf('{')));
  assert.deepEqual(detail.evidence, [{ mode: 'login', pid: 11, account: 'claude-1a2b3c4d' }, { mode: 'status', pid: 12, account: 'x' }]);
  assert.deepEqual(detail.fixtureFaults, ['claude-12-0123456789ab.txt: Error: EEXIST']);
  assert.deepEqual(detail.appNotices, ['Sign-out failed for A']);
});

test('the explanation stays short however much evidence piled up', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ mode: 'status', pid: index + 1, accountDir: 'D:\\root\\a' }));
  const faults = Array.from({ length: 50 }, (_, index) => ({ file: `claude-${index}-0123456789ab.txt`, text: 'x'.repeat(5000) }));
  const message = describeMissingLogout({ account: 'a', removalMs: 1, rows, faults, notices: Array(50).fill('n'.repeat(1000)) });
  assert.ok(message.length < 4000, String(message.length));
  // The newest evidence is the interesting one.
  const detail = JSON.parse(message.slice(message.indexOf('{')));
  assert.equal(detail.evidence.at(-1).pid, 200);
});
