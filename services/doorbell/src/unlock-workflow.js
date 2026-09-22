'use strict';

async function executeConfirmedUnlock({
  isStillAuthorized,
  isSameCallInstance,
  requireCall,
  accept,
  waitEstablished,
  publish,
  hangup,
  delayAfterPublish,
  onCleanupError = () => {},
}) {
  let accepted = false;
  try {
    await requireCall();
    await accept();
    accepted = true;
    await waitEstablished();
    await requireCall();
    if (!isStillAuthorized()) throw new Error('Freigabe ist vor MQTT-Versand abgelaufen');
    await publish();
    await delayAfterPublish();
  } finally {
    // Cleanup is independent from grant expiry or MQTT availability, but a
    // new local call instance may reuse the caller-controlled SIP Call-ID.
    if (accepted && isSameCallInstance()) {
      try {
        await hangup();
      } catch (error) {
        onCleanupError(error);
      }
    }
  }
}

module.exports = { executeConfirmedUnlock };
