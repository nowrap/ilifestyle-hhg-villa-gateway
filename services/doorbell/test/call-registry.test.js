'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CallRegistry,
  parseActiveCallCount,
  inventoryResponseIsCurrent,
} = require('../src/call-registry');

test('only one event-identified active call is eligible', () => {
  const calls = new CallRegistry();
  calls.reconcileCount(0);
  assert.equal(calls.incoming('call-a'), true);
  assert.equal(calls.current(true), 'call-a');
  calls.markEstablished('call-a');
  assert.equal(calls.isEstablished('call-a'), true);
});

test('parallel calls revoke eligibility and closing one does not promote the other', () => {
  const calls = new CallRegistry();
  calls.reconcileCount(0);
  calls.incoming('call-a');
  assert.equal(calls.incoming('call-b'), false);
  assert.equal(calls.current(true), null);
  calls.close('call-b');
  assert.equal(calls.hasSingleCall, false);
  assert.equal(calls.current(true), null);
  calls.reconcileCount(0);
  assert.equal(calls.incoming('call-c'), true);
});

test('duplicate active and missing call IDs fail closed', () => {
  const calls = new CallRegistry();
  calls.reconcileCount(0);
  calls.incoming('call-a');
  assert.equal(calls.incoming('call-a'), false);
  assert.equal(calls.current(true), null);
  assert.equal(calls.incoming(null), false);
  assert.equal(calls.hasSingleCall, false);
});

test('disconnect state stays locked until authoritative idle reconciliation', () => {
  const calls = new CallRegistry();
  calls.reconcileCount(0);
  calls.incoming('existing-call');
  calls.markUnknown();
  assert.equal(calls.incoming('call-b'), false);
  assert.equal(calls.current(true), null);
  calls.reconcileCount(1);
  assert.equal(calls.current(true), null);
  calls.reconcileCount(0);
  assert.equal(calls.incoming('call-c'), true);
});

test('duplicate ID remains locked after one close until listcalls confirms idle', () => {
  const calls = new CallRegistry();
  calls.reconcileCount(0);
  calls.incoming('call-a');
  calls.incoming('call-a');
  calls.close('call-a');
  assert.equal(calls.incoming('call-b'), false);
  calls.reconcileCount(1);
  assert.equal(calls.current(true), null);
  calls.reconcileCount(0);
  assert.equal(calls.incoming('call-c'), true);
});

test('listcalls parser handles supported and multi-UA formats fail closed', () => {
  assert.equal(parseActiveCallCount('List of active calls (0):'), 0);
  assert.equal(parseActiveCallCount('Active calls (1)'), 1);
  assert.equal(parseActiveCallCount('--- Active calls (1) ---\n--- Active calls (2) ---'), 3);
  assert.throws(() => parseActiveCallCount('unexpected output'), /did not contain a call count/);
});

test('a listcalls response is stale after any intervening call event', () => {
  const revisionBeforeRequest = 7;
  assert.equal(inventoryResponseIsCurrent(revisionBeforeRequest, 7), true);
  assert.equal(inventoryResponseIsCurrent(revisionBeforeRequest, 8), false);
});
