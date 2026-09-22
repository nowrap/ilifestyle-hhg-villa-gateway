'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const { spawn } = require('node:child_process');
const mqtt = require('mqtt');
const { BaresipControl } = require('./baresip-control');
const { CallRegistry, parseActiveCallCount, inventoryResponseIsCurrent } = require('./call-registry');
const { safeSnapshotPath, secretsEqual } = require('./safety');
const { executeConfirmedUnlock } = require('./unlock-workflow');

const listenPort = Number(process.env.NOTIFIER_PORT || 3000);
const webhookSecret = process.env.WEBHOOK_SECRET || '';
const rtspUrl = process.env.RTSP_URL || '';
const wahaUrl = new URL(process.env.WAHA_URL || 'http://waha:3000');
const wahaApiKey = process.env.WAHA_API_KEY || '';
const wahaSession = process.env.WAHA_SESSION || '';
const wahaChatId = process.env.WAHA_CHAT_ID || '';
const wahaWebhookSecret = process.env.WAHA_WEBHOOK_SECRET || '';
const localMqttUrl = process.env.LOCAL_MQTT_URL || 'mqtt://ilifestyle-mosquitto:1883';
const localMqttTopic = process.env.LOCAL_MQTT_TOPIC || '';
const localMqttFrom = process.env.LOCAL_MQTT_FROM || 'whatsapp';
const localMqttUsername = process.env.LOCAL_MQTT_USERNAME || '';
const localMqttPassword = process.env.LOCAL_MQTT_PASSWORD || '';
const baresipControlHost = process.env.BARESIP_CONTROL_HOST || '127.0.0.1';
const baresipControlPort = Number(process.env.BARESIP_CONTROL_PORT || 4444);
const unlockWindowMs = Number(process.env.UNLOCK_WINDOW_MS || 120000);
const unlockEnabled = process.env.UNLOCK_ENABLED === 'true';
const unlockAllowWholeGroup = process.env.UNLOCK_ALLOW_WHOLE_GROUP === 'true';
const unlockAllowedParticipants = new Set(
  (process.env.UNLOCK_ALLOWED_PARTICIPANTS || '').split(',').map((value) => value.trim()).filter(Boolean),
);
const minImageBytes = Number(process.env.MIN_IMAGE_BYTES || 8000);
const maxCaptureAttempts = Number(process.env.MAX_CAPTURE_ATTEMPTS || 5);
const captureRetryMs = Number(process.env.CAPTURE_RETRY_MS || 250);

for (const [name, value] of Object.entries({
  RTSP_URL: rtspUrl,
  WAHA_API_KEY: wahaApiKey,
  WAHA_SESSION: wahaSession,
  WAHA_CHAT_ID: wahaChatId,
  WAHA_WEBHOOK_SECRET: wahaWebhookSecret,
  LOCAL_MQTT_TOPIC: localMqttTopic,
})) {
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
}
if (unlockEnabled && !unlockAllowWholeGroup && unlockAllowedParticipants.size === 0) {
  throw new Error('Unlock is enabled but neither an allow-list nor explicit whole-group permission is configured');
}

const recentEvents = new Map();
const recentWebhookEvents = new Map();
let processing = false;
let queuedEvent = null;
let receivedEvents = 0;
let sentImages = 0;
let sentFallbacks = 0;
let failures = 0;
let unlockAttempts = 0;
let unlockSuccesses = 0;
let unlockRejections = 0;
let pendingUnlock = null;
let doorbellGeneration = 0;
let unlockInFlight = false;
let localMqttConnected = false;
let brokerClientCount = null;
let brokerClientCountAt = null;
let wahaReachable = false;
let wahaSessionStatus = 'unknown';
let wahaLastCheck = null;
let baresipReachable = false;
let baresipSingleCall = false;
let baresipLastCheck = null;

const localMqtt = mqtt.connect(localMqttUrl, {
  clientId: `doorbell-notifier-${process.pid}`,
  clean: true,
  reconnectPeriod: 2000,
  connectTimeout: 5000,
  queueQoSZero: false,
  ...(localMqttUsername ? { username: localMqttUsername, password: localMqttPassword } : {}),
});
localMqtt.on('connect', () => {
  localMqttConnected = true;
  localMqtt.subscribe('$SYS/broker/clients/connected', { qos: 0 }, (error) => {
    if (error) log({ event: 'local_mqtt_sys_subscribe_failed', error: error.message });
  });
  log({ event: 'local_mqtt_connected', url: localMqttUrl, topic: localMqttTopic });
});
localMqtt.on('close', () => {
  localMqttConnected = false;
  revokeUnlock('local_mqtt_disconnected');
});
localMqtt.on('error', (error) => log({ event: 'local_mqtt_error', error: error.message }));
localMqtt.on('message', (topic, payload) => {
  if (topic !== '$SYS/broker/clients/connected') return;
  const value = Number(payload.toString());
  if (Number.isFinite(value)) {
    brokerClientCount = value;
    brokerClientCountAt = new Date().toISOString();
  }
});

const log = (event) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const baresip = new BaresipControl({ host: baresipControlHost, port: baresipControlPort });
const calls = new CallRegistry();
let incomingCallSequence = 0;
let callEventRevision = 0;
let activeBaresipCallInstance = null;

function revokeUnlock(reason) {
  if (pendingUnlock) log({ event: 'doorbell_grant_revoked', reason, eventId: pendingUnlock.eventId });
  pendingUnlock = null;
  doorbellGeneration += 1;
}

baresip.on('connect', () => log({ event: 'baresip_control_connected' }));
baresip.on('disconnect', () => {
  baresipReachable = false;
  baresipSingleCall = false;
  calls.markUnknown();
  activeBaresipCallInstance = null;
  revokeUnlock('baresip_control_disconnected');
});
baresip.on('connectionError', (error) => log({ event: 'baresip_control_error', error: error.message }));
baresip.on('callEvent', (event) => {
  callEventRevision += 1;
  const callId = typeof event.id === 'string' && event.id ? event.id : null;
  if (event.type === 'CALL_INCOMING') {
    revokeUnlock('new_incoming_call');
    if (!callId) {
      calls.markUnknown();
      baresipSingleCall = false;
      activeBaresipCallInstance = null;
      log({ event: 'baresip_incoming_rejected', reason: 'missing_call_id' });
      return;
    }
    const callInstance = ++incomingCallSequence;
    if (!calls.incoming(callId)) {
      baresipSingleCall = false;
      activeBaresipCallInstance = null;
      log({ event: 'baresip_incoming_not_eligible', reason: 'not_exactly_one_unique_call', callId });
    } else {
      baresipSingleCall = true;
      activeBaresipCallInstance = callInstance;
    }
    acceptDoorbellEvent({
      event: 'doorbell', source: 'baresip-event', time: new Date().toISOString(),
      eventId: `baresip-${callId}-${callInstance}`,
      callIdentity: calls.current(baresip.connected) === callId ? callId : null,
      callInstance,
    });
  } else if (event.type === 'CALL_ESTABLISHED' && callId) {
    calls.markEstablished(callId);
  } else if (event.type === 'CALL_CLOSED') {
    calls.close(callId);
    baresipSingleCall = calls.hasSingleCall;
    activeBaresipCallInstance = null;
    revokeUnlock('call_closed');
  }
});
baresip.start();

function captureSnapshot(path) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp',
      '-i', rtspUrl, '-frames:v', '1', '-update', '1', '-q:v', '2', '-y', path,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => ffmpeg.kill('SIGKILL'), 5000);
    ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg ${signal || code}: ${stderr.slice(-300)}`));
      try {
        const stat = await fs.stat(path);
        resolve(stat.size);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function captureUsableSnapshot(path) {
  let lastError;
  for (let attempt = 1; attempt <= maxCaptureAttempts; attempt += 1) {
    try {
      const bytes = await captureSnapshot(path);
      log({ event: 'snapshot_attempt', attempt, bytes });
      if (bytes >= minImageBytes) return bytes;
      lastError = new Error(`image too small: ${bytes} bytes`);
    } catch (error) {
      lastError = error;
      log({ event: 'snapshot_attempt_failed', attempt, error: error.message });
    }
    await delay(captureRetryMs);
  }
  throw lastError || new Error('snapshot failed');
}

function postWaha(path, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      error ? reject(error) : resolve(value);
    };
    const request = http.request(new URL(path, wahaUrl), {
      method: 'POST',
      headers: {
        'x-api-key': wahaApiKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('aborted', () => finish(new Error('WAHA response aborted')));
      response.on('error', (error) => finish(error));
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) return finish(null, responseBody);
        finish(new Error(`WAHA HTTP ${response.statusCode}: ${responseBody.slice(0, 300)}`));
      });
    });
    request.on('error', (error) => finish(error));
    const overallTimer = setTimeout(() => {
      request.destroy();
      finish(new Error('WAHA request timeout'));
    }, timeoutMs);
    request.end(payload);
  });
}

function getWaha(path, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get(new URL(path, wahaUrl), {
      headers: { 'x-api-key': wahaApiKey, accept: 'application/json' },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return reject(new Error(`WAHA HTTP ${response.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('WAHA request timeout')));
    request.on('error', reject);
  });
}

async function checkWaha() {
  wahaLastCheck = new Date().toISOString();
  try {
    const session = await getWaha(`/api/sessions/${encodeURIComponent(wahaSession)}`);
    wahaReachable = true;
    wahaSessionStatus = String(session?.status || session?.engine?.state || 'unknown');
  } catch (error) {
    wahaReachable = false;
    wahaSessionStatus = 'unreachable';
    log({ event: 'waha_health_error', error: error.message });
  }
}

checkWaha();
setInterval(checkWaha, 60000).unref();

async function sendText(text) {
  await postWaha('/api/sendText', { session: wahaSession, chatId: wahaChatId, text });
}

function extractMessageId(responseBody) {
  try {
    const value = JSON.parse(responseBody);
    return value?.id || value?.key?.id || value?.message?.id || null;
  } catch {
    return null;
  }
}

function messageIdsMatch(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  return left === right || left.endsWith(`_${right}`) || right.endsWith(`_${left}`)
    || left.includes(`_${right}_`) || right.includes(`_${left}_`);
}

function publishLocalDoorOpen(isStillAuthorized) {
  return new Promise((resolve, reject) => {
    if (!isStillAuthorized()) return reject(new Error('Freigabe ist vor MQTT-Versand abgelaufen'));
    if (!localMqttConnected || !localMqtt.connected) return reject(new Error('Lokaler MQTT-Broker ist nicht verbunden'));
    const payload = JSON.stringify({ from: localMqttFrom, action: 'OPEN DOOR' });
    localMqtt.publish(localMqttTopic, payload, { qos: 0, retain: false }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const baresipCommand = (command, params = '') => baresip.command(command, params);

async function currentBaresipCallIdentity() {
  return calls.current(baresip.connected);
}

async function hangupExpectedCall(expectedIdentity) {
  const identity = await currentBaresipCallIdentity();
  if (!identity || identity !== expectedIdentity) throw new Error('cleanup call identity mismatch');
  await baresipCommand('hangup', expectedIdentity);
}

async function requireSingleBaresipCall(isStillAuthorized, expectedIdentity) {
  if (!isStillAuthorized()) throw new Error('Freigabe ist nicht mehr gültig');
  if (!baresip.connected || !calls.hasSingleCall) {
    throw new Error('Baresip hat nicht genau einen aktiven Call');
  }
  const identity = await currentBaresipCallIdentity();
  if (!identity) throw new Error('Baresip-Call hat keine verifizierte Event-ID');
  if (expectedIdentity && identity !== expectedIdentity) throw new Error('Der aktive SIP-Call gehört nicht mehr zum Klingelereignis');
  if (!isStillAuthorized()) throw new Error('Freigabe ist nicht mehr gültig');
}

async function waitForEstablishedBaresipCall(isStillAuthorized, expectedIdentity) {
  const deadline = Date.now() + 3000;
  do {
    await requireSingleBaresipCall(isStillAuthorized, expectedIdentity);
    if (calls.isEstablished(expectedIdentity)) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Baresip-Call wurde nicht als verbunden bestätigt');
}

async function runConfirmedCallMqttUnlock(unlock, isStillAuthorized) {
  await executeConfirmedUnlock({
    isStillAuthorized,
    isSameCallInstance: () => calls.current(baresip.connected) === unlock.callIdentity
      && activeBaresipCallInstance === unlock.callInstance,
    requireCall: () => requireSingleBaresipCall(isStillAuthorized, unlock.callIdentity),
    accept: () => baresipCommand('accept', unlock.callIdentity),
    waitEstablished: () => waitForEstablishedBaresipCall(isStillAuthorized, unlock.callIdentity),
    publish: async () => {
      await publishLocalDoorOpen(isStillAuthorized);
      log({ event: 'door_unlock_local_mqtt_published_after_sip_confirmed', eventId: unlock.eventId });
    },
    // Keep the confirmed call alive briefly so the gateway can process the
    // MQTT command in the same state in which the successful test ran.
    delayAfterPublish: () => delay(1200),
    hangup: () => hangupExpectedCall(unlock.callIdentity),
    onCleanupError: (error) => log({ event: 'baresip_unlock_cleanup_failed', error: error.message }),
  });
}

function webhookChatId(payload) {
  for (const value of [payload?.from, payload?.to, payload?.chatId]) {
    if (typeof value === 'string' && value.endsWith('@g.us')) return value;
  }
  return null;
}

function webhookParticipant(payload) {
  return payload?.participant || (payload?.from?.endsWith('@g.us') ? null : payload?.from) || null;
}

function unlockRequestFromWebhook(event) {
  const payload = event?.payload || {};
  if (event?.event === 'message.reaction') {
    if (payload.fromMe || payload.reaction?.text !== '🔓') return null;
    return {
      webhookId: payload.id,
      timestamp: Number(payload.timestamp) * 1000,
      targetMessageId: payload.reaction.messageId || null,
      participant: webhookParticipant(payload),
      requiresTarget: true,
    };
  }
  if (event?.event !== 'message' || payload.fromMe) return null;
  const command = String(payload.body || '').trim().toLocaleLowerCase('de-DE');
  if (!['auf', 'öffnen', 'oeffnen', '🔓'].includes(command)) return null;
  return {
    webhookId: payload.id,
    timestamp: Number(payload.timestamp) * 1000,
    targetMessageId: payload.replyTo?.id || null,
    participant: webhookParticipant(payload),
    requiresTarget: false,
  };
}

async function handleUnlockWebhook(event) {
  const request = unlockRequestFromWebhook(event);
  if (!request) return false;
  const now = Date.now();
  for (const [id, seenAt] of recentWebhookEvents) if (now - seenAt > 10 * 60 * 1000) recentWebhookEvents.delete(id);
  if (typeof request.webhookId !== 'string' || !request.webhookId || !Number.isFinite(request.timestamp)) {
    log({ event: 'unlock_rejected_invalid_webhook' });
    return true;
  }
  if (recentWebhookEvents.has(request.webhookId)) {
    log({ event: 'unlock_webhook_duplicate', webhookId: request.webhookId });
    return true;
  }
  recentWebhookEvents.set(request.webhookId, now);
  unlockAttempts += 1;

  let reply;
  if (event.session !== wahaSession || webhookChatId(event.payload) !== wahaChatId) {
    unlockRejections += 1;
    log({ event: 'unlock_ignored_wrong_context' });
    return true;
  } else if (!unlockEnabled) {
    unlockRejections += 1;
    reply = '⛔ Abgelehnt: Türöffnung ist deaktiviert.';
  } else if (!unlockAllowWholeGroup && (!request.participant || !unlockAllowedParticipants.has(request.participant))) {
    unlockRejections += 1;
    reply = '⛔ Abgelehnt: Du bist für die Türöffnung nicht freigeschaltet.';
  } else if (!pendingUnlock) {
    unlockRejections += 1;
    reply = '⛔ Abgelehnt: Es liegt kein aktuelles Klingelereignis vor.';
  } else if (now > pendingUnlock.expiresAt) {
    unlockRejections += 1;
    reply = '⌛ Abgelehnt: Das letzte Klingeln ist länger als 2 Minuten her.';
  } else if (request.timestamp < Math.floor(pendingUnlock.activatedAt / 1000) * 1000 || request.timestamp > now + 30000) {
    unlockRejections += 1;
    reply = '⌛ Abgelehnt: Der Befehl gehört nicht zum aktuellen Klingeln.';
  } else if (request.requiresTarget && !messageIdsMatch(request.targetMessageId, pendingUnlock.messageId)) {
    unlockRejections += 1;
    reply = '⛔ Abgelehnt: Die Reaktion gehört nicht zum aktuellen Klingelbild.';
  } else if (request.targetMessageId && !messageIdsMatch(request.targetMessageId, pendingUnlock.messageId)) {
    unlockRejections += 1;
    reply = '⛔ Abgelehnt: Die Reaktion oder Antwort gehört nicht zum aktuellen Klingelbild.';
  } else if (pendingUnlock.used || unlockInFlight) {
    unlockRejections += 1;
    reply = 'ℹ️ Abgelehnt: Für dieses Klingeln wurde bereits ein Öffnungsbefehl ausgeführt.';
  } else {
    // Mark first so concurrent/retried webhooks cannot operate the relay twice.
    const unlock = pendingUnlock;
    unlock.used = true;
    unlockInFlight = true;
    try {
      const isStillAuthorized = () => pendingUnlock === unlock
        && unlock.generation === doorbellGeneration
        && Date.now() <= unlock.expiresAt;
      await sendText('🔐 Öffne: SIP-Verbindung wird bestätigt, danach folgt der einmalige MQTT-Befehl.');
      await runConfirmedCallMqttUnlock(unlock, isStillAuthorized);
      unlockSuccesses += 1;
      reply = '✅ Öffnungsbefehl über bestätigten SIP-Call und MQTT gesendet.';
      log({ event: 'door_unlock_command_sent', eventId: unlock.eventId });
    } catch (error) {
      failures += 1;
      // Keep the event consumed: a failed TCP write can be ambiguous and must
      // never be retried automatically against a physical actuator.
      reply = '⚠️ Öffnungsbefehl fehlgeschlagen oder nicht sicher bestätigt. Kein automatischer Wiederholungsversuch.';
      log({ event: 'door_unlock_failed', eventId: unlock.eventId, error: error.message });
    } finally {
      unlockInFlight = false;
    }
  }
  await sendText(reply);
  return true;
}

async function processEvent(event) {
  const snapshotPath = safeSnapshotPath(event.eventId);
  // A new ring immediately invalidates the previous door-opening grant, even
  // while the new snapshot is still being captured.
  pendingUnlock = null;
  try {
    const bytes = await captureUsableSnapshot(snapshotPath);
    const data = await fs.readFile(snapshotPath, 'base64');
    const responseBody = await postWaha('/api/sendImage', {
      session: wahaSession,
      chatId: wahaChatId,
      file: { mimetype: 'image/jpeg', filename: 'klingel.jpg', data },
      caption: `🔔 Es hat geklingelt (${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })})`,
    });
    const currentCallIdentity = await currentBaresipCallIdentity();
    const callIdentity = event.callIdentity
      ? (event.callIdentity === currentCallIdentity ? currentCallIdentity : null)
      : currentCallIdentity;
    if (event.generation === doorbellGeneration && callIdentity) {
      const createdAt = Date.parse(event.time);
      pendingUnlock = {
        eventId: event.eventId,
        generation: event.generation,
        messageId: extractMessageId(responseBody),
        createdAt,
        activatedAt: Date.now(),
        expiresAt: createdAt + unlockWindowMs,
        used: false,
        callIdentity,
        callInstance: event.callInstance || activeBaresipCallInstance,
      };
    } else if (!callIdentity) {
      log({ event: 'doorbell_grant_not_created', eventId: event.eventId, reason: 'no_single_baresip_call' });
    } else {
      log({ event: 'doorbell_grant_superseded', eventId: event.eventId });
    }
    sentImages += 1;
    log({ event: 'doorbell_image_sent', eventId: event.eventId, bytes });
  } catch (error) {
    failures += 1;
    log({ event: 'doorbell_image_failed', eventId: event.eventId, error: error.message });
    try {
      await sendText('🔔 Es hat geklingelt – Kamerabild momentan nicht verfügbar.');
      sentFallbacks += 1;
      log({ event: 'doorbell_fallback_sent', eventId: event.eventId });
    } catch (fallbackError) {
      log({ event: 'doorbell_fallback_failed', eventId: event.eventId, error: fallbackError.message });
    }
  } finally {
    await fs.rm(snapshotPath, { force: true }).catch(() => {});
  }
}

async function drainQueue(event) {
  if (processing) {
    queuedEvent = event;
    return;
  }
  processing = true;
  let current = event;
  while (current) {
    await processEvent(current);
    current = queuedEvent;
    queuedEvent = null;
  }
  processing = false;
}

function acceptDoorbellEvent(event) {
  const now = Date.now();
  const eventTime = Date.parse(event.time);
  if (!event.eventId || !Number.isFinite(eventTime) || eventTime < now - 60000 || eventTime > now + 30000) return false;
  for (const [eventId, seenAt] of recentEvents) if (now - seenAt > 10 * 60 * 1000) recentEvents.delete(eventId);
  if (recentEvents.has(event.eventId)) return true;
  recentEvents.set(event.eventId, now);
  doorbellGeneration += 1;
  event.generation = doorbellGeneration;
  pendingUnlock = null;
  receivedEvents += 1;
  drainQueue(event).catch((error) => log({ event: 'queue_failed', error: error.message }));
  return true;
}

async function pollBaresip() {
  baresipLastCheck = new Date().toISOString();
  const revisionBeforeRequest = callEventRevision;
  try {
    const activeCallCount = parseActiveCallCount(await baresipCommand('listcalls'));
    if (!inventoryResponseIsCurrent(revisionBeforeRequest, callEventRevision)) {
      baresipReachable = true;
      baresipSingleCall = calls.hasSingleCall;
      log({ event: 'baresip_poll_stale_response_ignored' });
      return;
    }
    const previouslyEligible = Boolean(calls.current(baresip.connected));
    calls.reconcileCount(activeCallCount);
    baresipReachable = true;
    baresipSingleCall = calls.hasSingleCall;
    if (previouslyEligible && !calls.current(baresip.connected)) {
      activeBaresipCallInstance = null;
      revokeUnlock('active_call_missing');
    }
  } catch (error) {
    baresipReachable = false;
    baresipSingleCall = false;
    calls.markUnknown();
    activeBaresipCallInstance = null;
    revokeUnlock('baresip_poll_failed');
    log({ event: 'baresip_poll_failed', error: error.message });
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    // Mosquitto publishes this retained value whenever the count changes; it
    // is not a heartbeat and therefore must not be rejected based on age.
    const gatewayMqttProbablyPresent = brokerClientCount >= 2;
    const ready = localMqttConnected && gatewayMqttProbablyPresent && baresipReachable
      && wahaReachable && wahaSessionStatus === 'WORKING';
    response.statusCode = ready ? 200 : 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      status: ready ? 'ok' : 'degraded', processing, receivedEvents, sentImages, sentFallbacks, failures,
      unlockAttempts, unlockCommandsSent: unlockSuccesses, unlockRejections,
      localMqttConnected,
      gatewayMqttProbablyPresent, brokerClientCount, brokerClientCountAt,
      wahaReachable, wahaSessionStatus, wahaLastCheck,
      baresipReachable, baresipSingleCall, baresipLastCheck,
      unlockEnabled,
      unlockPending: unlockEnabled && Boolean(pendingUnlock && !pendingUnlock.used && Date.now() <= pendingUnlock.expiresAt),
    }));
    return;
  }
  if (request.method === 'POST' && request.url === '/waha') {
    if (!secretsEqual(request.headers['x-ilifestyle-secret'], wahaWebhookSecret)) return response.writeHead(403).end();
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) request.destroy();
    });
    request.on('end', () => {
      try {
        const event = JSON.parse(body);
        handleUnlockWebhook(event).catch((error) => log({ event: 'unlock_webhook_failed', error: error.message }));
        response.writeHead(202).end();
      } catch {
        response.writeHead(400).end();
      }
    });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/doorbell') return response.writeHead(404).end();
  if (!secretsEqual(request.headers['x-ilifestyle-secret'], webhookSecret)) return response.writeHead(403).end();

  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096) request.destroy();
  });
  request.on('end', () => {
    try {
      const event = JSON.parse(body);
      if (event.event !== 'doorbell' || event.source !== 'sip-invite' || !acceptDoorbellEvent(event)) return response.writeHead(400).end();
      response.writeHead(202).end();
    } catch (error) {
      response.writeHead(400).end();
    }
  });
});

server.on('error', (error) => {
  log({ event: 'server_error', error: error.message });
  process.exitCode = 1;
});

server.listen(listenPort, '0.0.0.0', () => log({ event: 'notifier_ready', listen: `0.0.0.0:${listenPort}` }));
pollBaresip();
setInterval(pollBaresip, 1000).unref();
