'use strict';

const crypto = require('node:crypto');

function safeSnapshotPath(eventId) {
  const digest = crypto.createHash('sha256').update(String(eventId)).digest('hex').slice(0, 32);
  return `/tmp/ilifestyle-doorbell-${digest}.jpg`;
}

function secretsEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

module.exports = { safeSnapshotPath, secretsEqual };
