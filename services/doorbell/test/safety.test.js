'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { safeSnapshotPath, secretsEqual } = require('../src/safety');

test('snapshot path cannot be controlled by a SIP Call-ID', () => {
  const path = safeSnapshotPath('../../../etc/cron.d/x');
  assert.match(path, /^\/tmp\/ilifestyle-doorbell-[a-f0-9]{32}\.jpg$/);
  assert.equal(path.includes('..'), false);
  assert.equal(path.includes('cron'), false);
});

test('secret comparison rejects missing and mismatched secrets', () => {
  assert.equal(secretsEqual('secret', 'secret'), true);
  assert.equal(secretsEqual('Secret', 'secret'), false);
  assert.equal(secretsEqual('short', 'longer'), false);
  assert.equal(secretsEqual(undefined, 'secret'), false);
  assert.equal(secretsEqual('secret', ''), false);
});
