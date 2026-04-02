/**
 * ilifestyle-iobroker.js
 * ioBroker JavaScript adapter for HHG Villa GW AV-Link Gateway (AVL20P)
 * via iLifestyle Cloud MQTT
 *
 * Install in ioBroker: Scripts → JavaScript → New Script → paste this file
 * Requires: ioBroker javascript adapter + mqtt adapter
 *           OR node-red with mqtt node
 *
 * Datapoints created under: javascript.0.ilifestyle.*
 */

// ─── Configuration ────────────────────────────────────────────────────────────
const AVL_IP       = '192.168.0.14';   // IP of your AVL20P gateway
const AVL_USER     = 'admin';           // Gateway web UI username
const AVL_PASS     = 'admin';           // Gateway web UI password
const MQTT_HOST    = 'de.ilifestyle-cloud.com';
const MQTT_PORT    = 1883;
const DOORBELL_RESET_MS = 5000;        // ms until doorbell state resets to false
const TOKEN_REFRESH_MS  = 3600000;     // refresh token every 60 minutes
// ──────────────────────────────────────────────────────────────────────────────

const http = require('http');
const mqtt = require('mqtt');

let mqttClient  = null;
let deviceId    = null;
let cloudToken  = null;
let tokenTimer  = null;

// ─── Datapoints ───────────────────────────────────────────────────────────────
createState('ilifestyle.connected',     false, { type: 'boolean', role: 'indicator.connected', read: true,  write: false, desc: 'MQTT connection state' });
createState('ilifestyle.doorbell',      false, { type: 'boolean', role: 'button',              read: true,  write: false, desc: 'Doorbell triggered' });
createState('ilifestyle.camera_active', false, { type: 'boolean', role: 'indicator',           read: true,  write: false, desc: 'Camera stream active' });
createState('ilifestyle.open_door',     false, { type: 'boolean', role: 'button',              read: true,  write: true,  desc: 'Set true to open door' });
createState('ilifestyle.rtmp_url',      '',    { type: 'string',  role: 'url',                 read: true,  write: false, desc: 'RTMP stream URL' });
createState('ilifestyle.last_event',    '',    { type: 'string',  role: 'text',                read: true,  write: false, desc: 'Last raw MQTT payload' });

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
function httpGet(url, cookie) {
    return new Promise((resolve, reject) => {
        const options = { headers: cookie ? { Cookie: `token=${cookie}` } : {} };
        http.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function httpPost(url, body) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        };
        const req = http.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

// ─── Token Fetch ──────────────────────────────────────────────────────────────
async function fetchTokens() {
    log('iLifestyle: fetching tokens from gateway...');
    try {
        const loginRes = await httpPost(`http://${AVL_IP}/api/login`, { name: AVL_USER, password: AVL_PASS });
        if (loginRes.status !== 0) throw new Error('Login failed');
        const sessionToken = loginRes.token;

        const accountRes = await httpGet(`http://${AVL_IP}/api/account`, sessionToken);
        if (accountRes.status !== 0) throw new Error('Account fetch failed');
        cloudToken = accountRes.token;

        const macRes = await httpGet(`http://${AVL_IP}/api/mac`, sessionToken);
        if (macRes.status !== 0) throw new Error('MAC fetch failed');
        deviceId = macRes.mac.replace(/:/g, '');

        const videoRes = await httpGet(`http://${AVL_IP}/api/video`, sessionToken);
        if (videoRes.status === 0) setState('javascript.0.ilifestyle.rtmp_url', videoRes.rtmp || '', true);

        log(`iLifestyle: device=${deviceId}`);
        return true;
    } catch (e) {
        log('iLifestyle: token fetch error: ' + e.message, 'error');
        return false;
    }
}

// ─── MQTT Connect ─────────────────────────────────────────────────────────────
function connectMqtt() {
    if (!deviceId || !cloudToken) {
        log('iLifestyle: no credentials, cannot connect', 'warn');
        return;
    }

    if (mqttClient) {
        mqttClient.end(true);
        mqttClient = null;
    }

    log(`iLifestyle: connecting to ${MQTT_HOST}:${MQTT_PORT}...`);

    mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
        clientId:  `ioBroker|${deviceId}`,
        username:  deviceId,
        password:  cloudToken,
        reconnectPeriod: 10000,
        connectTimeout:  15000,
    });

    mqttClient.on('connect', () => {
        log('iLifestyle: MQTT connected');
        setState('javascript.0.ilifestyle.connected', true, true);
        mqttClient.subscribe(`${deviceId}/#`, (err) => {
            if (err) log('iLifestyle: subscribe error: ' + err.message, 'error');
            else log(`iLifestyle: subscribed to ${deviceId}/#`);
        });
    });

    mqttClient.on('disconnect', () => {
        log('iLifestyle: MQTT disconnected');
        setState('javascript.0.ilifestyle.connected', false, true);
    });

    mqttClient.on('error', (err) => {
        log('iLifestyle: MQTT error: ' + err.message, 'error');
        setState('javascript.0.ilifestyle.connected', false, true);
    });

    mqttClient.on('message', (topic, message) => {
        handleMessage(topic, message.toString());
    });
}

// ─── Message Handler ──────────────────────────────────────────────────────────
function handleMessage(topic, payload) {
    log(`iLifestyle: [${topic}] ${payload}`);
    setState('javascript.0.ilifestyle.last_event', payload, true);

    let msg;
    try { msg = JSON.parse(payload); }
    catch (e) { return; }

    const action = (msg.action || '').toLowerCase();

    // Doorbell ring
    if (action === 'ring') {
        log('iLifestyle: 🔔 Doorbell!');
        setState('javascript.0.ilifestyle.doorbell', true, true);
        setTimeout(() => setState('javascript.0.ilifestyle.doorbell', false, true), DOORBELL_RESET_MS);
    }

    // Camera / monitor active
    if (action === 'monitor') {
        const active = msg.ctrl === '1';
        setState('javascript.0.ilifestyle.camera_active', active, true);
    }
}

// ─── Door Open Trigger ────────────────────────────────────────────────────────
on({ id: 'javascript.0.ilifestyle.open_door', change: 'any' }, (obj) => {
    if (obj.state && obj.state.val === true) {
        log('iLifestyle: opening door...');
        if (mqttClient && mqttClient.connected) {
            mqttClient.publish(deviceId, JSON.stringify({ action: 'OPEN DOOR' }));
            log('iLifestyle: door open command sent');
        } else {
            log('iLifestyle: MQTT not connected, cannot open door', 'warn');
        }
        setTimeout(() => setState('javascript.0.ilifestyle.open_door', false, true), 1000);
    }
});

// ─── Token Refresh ────────────────────────────────────────────────────────────
async function refreshAndConnect() {
    const ok = await fetchTokens();
    if (ok) connectMqtt();
    else setTimeout(refreshAndConnect, 30000);
}

if (tokenTimer) clearInterval(tokenTimer);
tokenTimer = setInterval(async () => {
    log('iLifestyle: refreshing token...');
    const ok = await fetchTokens();
    if (ok && mqttClient) {
        mqttClient.options.username = deviceId;
        mqttClient.options.password = cloudToken;
    }
}, TOKEN_REFRESH_MS);

// ─── Start ────────────────────────────────────────────────────────────────────
refreshAndConnect();

onStop(() => {
    if (mqttClient) mqttClient.end(true);
    if (tokenTimer) clearInterval(tokenTimer);
    log('iLifestyle: stopped');
});
