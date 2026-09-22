'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { executeConfirmedUnlock } = require('../src/unlock-workflow');

function fixture() {
  const calls = [];
  let authorized = true;
  let sameCallInstance = true;
  return {
    calls,
    revoke: () => { authorized = false; },
    replaceCall: () => { authorized = false; sameCallInstance = false; },
    options: {
      isStillAuthorized: () => authorized,
      isSameCallInstance: () => sameCallInstance,
      requireCall: async () => { calls.push('require'); if (!authorized) throw new Error('revoked'); },
      accept: async () => { calls.push('accept'); },
      waitEstablished: async () => { calls.push('established'); },
      publish: async () => { calls.push('publish'); },
      hangup: async () => { calls.push('hangup'); },
      delayAfterPublish: async () => { calls.push('delay'); },
    },
  };
}

test('confirmed workflow publishes exactly once and hangs up the same generation', async () => {
  const f = fixture();
  await executeConfirmedUnlock(f.options);
  assert.deepEqual(f.calls, ['require', 'accept', 'established', 'require', 'publish', 'delay', 'hangup']);
  assert.equal(f.calls.filter((step) => step === 'publish').length, 1);
});

test('revocation before publish prevents publish but cleans up the same call instance', async () => {
  const f = fixture();
  f.options.waitEstablished = async () => { f.calls.push('established'); f.revoke(); };
  await assert.rejects(executeConfirmedUnlock(f.options), /revoked/);
  assert.equal(f.calls.includes('publish'), false);
  assert.equal(f.calls.includes('hangup'), true);
});

test('generation change during post-publish delay does not hang up a reused call ID', async () => {
  const f = fixture();
  f.options.delayAfterPublish = async () => { f.calls.push('delay'); f.replaceCall(); };
  await executeConfirmedUnlock(f.options);
  assert.equal(f.calls.filter((step) => step === 'publish').length, 1);
  assert.equal(f.calls.includes('hangup'), false);
});
