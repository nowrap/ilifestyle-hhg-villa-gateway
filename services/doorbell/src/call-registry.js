'use strict';

class CallRegistry {
  constructor() {
    this.markUnknown();
  }

  markKnownIdle() {
    this.active = new Set();
    this.established = new Set();
    this.eligible = null;
    this.known = true;
  }

  markUnknown() {
    this.active = new Set();
    this.established = new Set();
    this.eligible = null;
    this.known = false;
  }

  reconcileCount(count) {
    if (!Number.isSafeInteger(count) || count < 0) {
      this.markUnknown();
      return;
    }
    if (count === 0) {
      this.markKnownIdle();
      return;
    }
    if (!this.known || count !== this.active.size) this.markUnknown();
  }

  incoming(callId) {
    if (!callId) {
      this.markUnknown();
      return false;
    }
    if (!this.known || this.active.size !== 0 || this.active.has(callId)) {
      this.markUnknown();
      return false;
    }
    this.active.add(callId);
    this.eligible = this.active.size === 1 ? callId : null;
    return Boolean(this.eligible);
  }

  markEstablished(callId) {
    if (callId && this.active.has(callId)) this.established.add(callId);
  }

  close(callId) {
    if (!this.known) return;
    if (callId) {
      this.active.delete(callId);
      this.established.delete(callId);
    } else {
      this.active.clear();
      this.established.clear();
    }
    // A remaining call may previously have been ambiguous. Never promote it.
    this.eligible = null;
  }

  get hasSingleCall() {
    return this.known && this.active.size === 1;
  }

  current(connected) {
    if (!connected || !this.hasSingleCall || !this.eligible) return null;
    return this.active.has(this.eligible) ? this.eligible : null;
  }

  isEstablished(callId) {
    return Boolean(callId && this.established.has(callId));
  }
}

function parseActiveCallCount(output) {
  const matches = [...String(output).matchAll(/(?:List of active calls|Active calls)\s*\((\d+)\)/gi)];
  if (matches.length === 0) throw new Error('Baresip listcalls response did not contain a call count');
  return matches.reduce((sum, match) => sum + Number(match[1]), 0);
}

function inventoryResponseIsCurrent(requestRevision, currentRevision) {
  return Number.isSafeInteger(requestRevision)
    && Number.isSafeInteger(currentRevision)
    && requestRevision === currentRevision;
}

module.exports = { CallRegistry, parseActiveCallCount, inventoryResponseIsCurrent };
