# Installation

This guide installs the tested local path:

```text
gateway --SIP--> Baresip --events--> doorbell service
gateway --RTSP---------------------> doorbell service
doorbell service --image----------> WAHA --WhatsApp--> group
doorbell service --MQTT-----------> local broker --> gateway
```

Read the limitations first. Do not enable the door opener until ring detection
and image delivery work reliably.

## 1. What you need

- A Linux Docker host with a fixed LAN address.
- Docker Engine with the Compose plugin.
- An HHG Villa GW / AVL20P reachable from that host.
- Working RTSP access at `rtsp://GATEWAY_IP/live.sdp`.
- Access to the gateway call settings so it can call a local SIP IP target.
- A dedicated WhatsApp account linked to WAHA.
- The WhatsApp group ID and, unless the whole group may unlock, the participant
  IDs that are allowed to open the door.
- A local TLS MQTT endpoint that the gateway trusts, plus the MQTT username and
  password used by the gateway.

The last item is important. The included Mosquitto service listens only on
`127.0.0.1:1883`. A TLS proxy or another trusted TLS endpoint must expose it to
the gateway. How the gateway MQTT endpoint and credentials are changed is not
yet a portable, supported part of this repository. If your gateway still uses
the vendor MQTT broker, the local unlock path described here is incomplete.

## 2. Get the files

```sh
git clone https://github.com/nowrap/ilifestyle-hhg-villa-gateway.git
cd ilifestyle-hhg-villa-gateway
git switch dev
cp .env.example .env
cp compose.example.yaml compose.yaml
cp deploy/baresip/config/config.example deploy/baresip/config/config
cp deploy/baresip/config/accounts.example deploy/baresip/config/accounts
cp deploy/mosquitto/config/mosquitto.conf.example deploy/mosquitto/config/mosquitto.conf
cp deploy/mosquitto/config/acl.example deploy/mosquitto/config/acl
mkdir -p deploy/mosquitto/secrets
```

The examples use these local ports:

| Port | Purpose | Exposure |
|---|---|---|
| `5070/udp` | SIP from the gateway to Baresip | LAN |
| `4444/tcp` | Baresip control | loopback only |
| `1883/tcp` | Mosquitto behind the TLS endpoint | loopback only |
| `3002/tcp` | WAHA dashboard/API | loopback only |
| `3003/tcp` | doorbell service and WAHA webhook | host; restrict by firewall |

## 3. Configure Baresip

Replace `192.0.2.20` in both files with the fixed LAN address of the Docker
host:

- `deploy/baresip/config/config`
- `deploy/baresip/config/accounts`

Keep exactly one Baresip account. Keep `call_max_calls 1` and
`ctrl_tcp_listen 127.0.0.1:4444`. Do not expose port 4444 to the LAN.

The resulting account has this form:

```text
<sip:bus1@DOCKER_HOST_IP:5070>;regint=0;answermode=manual;dtmfmode=auto
```

## 4. Configure Mosquitto

Choose two different passwords: the existing password used by the gateway and
a new password for the notifier. Set a shell variable containing the gateway
device ID without colons, then create the password file:

```sh
DEVICE_ID=YOUR_DEVICE_ID
docker run --rm \
  -v "$PWD/deploy/mosquitto/secrets:/work" \
  eclipse-mosquitto:2 \
  mosquitto_passwd -b -c /work/passwd "$DEVICE_ID" 'GATEWAY_MQTT_PASSWORD'

docker run --rm \
  -v "$PWD/deploy/mosquitto/secrets:/work" \
  eclipse-mosquitto:2 \
  mosquitto_passwd -b /work/passwd doorbell-notifier 'NOTIFIER_MQTT_PASSWORD'
```

Replace every `YOUR_DEVICE_ID` in `deploy/mosquitto/config/acl` with the same
device ID. The gateway may read only its device topic. The notifier may publish
only to that topic and read the Mosquitto client-count metric.

Your gateway-facing TLS endpoint must forward MQTT to
`127.0.0.1:1883`. Do not expose this plain MQTT listener directly to the LAN.

## 5. Configure `.env`

Edit `.env` and replace every placeholder. A minimal example is:

```dotenv
RTSP_URL=rtsp://GATEWAY_IP/live.sdp
LOCAL_MQTT_URL=mqtt://127.0.0.1:1883
LOCAL_MQTT_TOPIC=YOUR_DEVICE_ID
LOCAL_MQTT_USERNAME=doorbell-notifier
LOCAL_MQTT_PASSWORD=NOTIFIER_MQTT_PASSWORD
LOCAL_MQTT_FROM=whatsapp

BARESIP_CONTROL_HOST=127.0.0.1
BARESIP_CONTROL_PORT=4444
NOTIFIER_PORT=3003

WAHA_URL=http://127.0.0.1:3002
WAHA_API_KEY=GENERATE_A_LONG_RANDOM_VALUE
WAHA_SESSION=default
WAHA_CHAT_ID=YOUR_GROUP_ID@g.us
WAHA_WEBHOOK_SECRET=GENERATE_ANOTHER_LONG_RANDOM_VALUE

WEBHOOK_SECRET=GENERATE_A_THIRD_LONG_RANDOM_VALUE
UNLOCK_ENABLED=false
UNLOCK_ALLOWED_PARTICIPANTS=
UNLOCK_ALLOW_WHOLE_GROUP=false
UNLOCK_WINDOW_MS=120000

MAX_CAPTURE_ATTEMPTS=2
CAPTURE_RETRY_MS=250
SNAPSHOT_MAX_WAIT_MS=4000
SNAPSHOT_STABLE_MS=500
SNAPSHOT_CROP_RIGHT=10
SNAPSHOT_ENHANCE=true
```

Generate secrets, for example, with:

```sh
openssl rand -hex 32
```

Do not commit `.env` or the Mosquitto password file.

## 6. Start and link WAHA

Start WAHA first:

```sh
docker compose up -d waha
docker compose logs -f waha
```

Open `http://127.0.0.1:3002/dashboard` on the Docker host. When working over
SSH, forward the port instead of exposing it publicly:

```sh
ssh -L 3002:127.0.0.1:3002 user@DOCKER_HOST_IP
```

Create the session named in `WAHA_SESSION`, scan the QR code and wait until its
status is `WORKING`. Find the target group in the WAHA dashboard or event
monitor and enter its ID, ending in `@g.us`, as `WAHA_CHAT_ID`.

The Compose file sends only `message` and `message.reaction` webhooks to the
doorbell service. It adds the shared `X-Ilifestyle-Secret` header automatically.
WAHA's API and webhook settings are described in the official
[WAHA event documentation](https://waha.devlike.pro/docs/how-to/events/).

## 7. Configure the gateway SIP target

In the gateway web interface, add or edit the call entry for the required bus
address:

- connection type: `IP`;
- target: `bus1@DOCKER_HOST_IP:5070`;
- bus address: the address assigned to the matching outdoor station.

Names differ between firmware versions. The important result is an incoming
SIP call at the Docker host on port 5070. Do not add unrelated accounts or call
targets to this Baresip instance.

Configure the gateway MQTT endpoint to use your trusted local TLS endpoint and
the gateway credentials entered in the Mosquitto password file. This repository
does not provide a universal gateway-MQTT provisioning tool.

## 8. Start the local services

```sh
docker compose build baresip doorbell
docker compose up -d mosquitto baresip doorbell
docker compose ps
```

Watch the first startup:

```sh
docker compose logs -f mosquitto baresip doorbell
```

Useful checks:

```sh
curl -sS -H "X-Api-Key: $WAHA_API_KEY" http://127.0.0.1:3002/api/sessions
curl -sS http://127.0.0.1:3003/health
```

The doorbell health endpoint returns `503 degraded` until WAHA is working,
Baresip control is reachable and the broker client count suggests that both the
notifier and gateway are connected. The client count is only a heuristic.

## 9. Test with unlocking disabled

Keep `UNLOCK_ENABLED=false`.

1. Ring the configured outdoor station.
2. Confirm that Baresip logs one `CALL_INCOMING` event.
3. Confirm that the WhatsApp group receives a current camera image.
4. Send `auf` in the group. The bot must answer that door opening is disabled.
5. Ring twice within 60 seconds. Both rings must produce an image.

Do not continue until these checks work reliably.

## 10. Enable door opening

The safer option is an explicit participant allow-list:

```dotenv
UNLOCK_ENABLED=true
UNLOCK_ALLOWED_PARTICIPANTS=FIRST_USER_ID@c.us,SECOND_USER_ID@c.us
UNLOCK_ALLOW_WHOLE_GROUP=false
```

Use WAHA's event monitor to obtain the exact participant IDs produced by your
engine. Restart the notifier after changing `.env`:

```sh
docker compose up -d --force-recreate doorbell
```

After a new ring, an allowed participant can:

- react to the current image with `🔓`; or
- send exactly `auf`, `öffnen`, `oeffnen` or `🔓` within the configured window.

A reaction must target the current image. A reply targeting another message is
rejected. Each ring permits at most one opening attempt. Failures are not
retried automatically.

Only set `UNLOCK_ALLOW_WHOLE_GROUP=true` if every group member may open the
door.

## 11. Required physical acceptance tests

Before normal use, verify all of these on site:

1. One authorized command causes exactly one relay operation.
2. A second command for the same ring is rejected.
3. A command after the time window is rejected.
4. An unauthorized participant is rejected.
5. Broker loss during opening causes no delayed MQTT command after reconnect.
6. A closed or replaced SIP call cannot open the door.
7. Restarting every container does not enable unlocking by itself.
8. The system behaves as expected when the vendor app is used at the same time.

Cold start without the vendor cloud and long-term cloud-free operation remain
acceptance tests for each installation.

## Troubleshooting

### No WhatsApp image

- Check that the WAHA session is `WORKING`.
- Check `WAHA_CHAT_ID`, `WAHA_SESSION` and `WAHA_API_KEY`.
- Run FFmpeg against `RTSP_URL` from the Docker host.
- Look for `snapshot_attempt_failed` and `doorbell_image_failed` in the
  doorbell logs.
- `no usable frame within 4000 ms` means the stream stayed on the blue
  no-signal screen, froze or never settled. Check that the door camera is
  switched on during the call.

### Snapshot quality

The notifier does not use the first decodable frame. On the tested AVL20P the
camera needs about 1–3 s after the button press: the gateway first streams a
blue no-signal screen, then pauses, then emits torn or overexposed frames. The
service reads raw frames until the mean luma has been stable for
`SNAPSHOT_STABLE_MS` without gaps or blue frames, stops the RTSP session and
encodes only that frame. It gives up after `SNAPSHOT_MAX_WAIT_MS`.

`SNAPSHOT_ENHANCE=true` applies an adaptive tone curve only to hazy, backlit
pictures (10th luma percentile above 30) plus slight sharpening; normally
exposed pictures keep their tonality. `SNAPSHOT_CROP_RIGHT` removes the black
border added by the analog video decoder. Each `snapshot_attempt` log entry
contains the waiting time, frame count, measured black level and applied curve.

### No incoming SIP call

- Check that the gateway target uses the Docker host IP and port 5070.
- Check the bus address assigned to the call entry.
- Check the host firewall and `docker compose logs baresip`.
- Do not expose or change the loopback-only control port 4444.

### Health remains degraded

Inspect the JSON response from `/health`. It reports WAHA, Baresip, MQTT and
broker-client state separately. The gateway must connect to the local MQTT
endpoint before `gatewayMqttProbablyPresent` can become true.

### Image arrives but the door does not open

- Confirm `UNLOCK_ENABLED=true` and the participant allow-list.
- Confirm the bot's response in WhatsApp; it states why a request was rejected.
  If there is no response at all, see the next section instead.
- Confirm that the gateway is connected to the local broker with permission to
  read its device topic.
- Confirm that Baresip accepted the same Call-ID before MQTT was published.
- Do not retry a failed operation automatically.

### The reply is not answered at all

Every rejection path answers in the chat ("⛔ not authorised", "⌛ older than two
minutes", …). **Silence therefore means the notifier never saw the message**, and
the fault is in webhook delivery rather than in the unlock logic. The doorbell
image still arrives in this state, because that path is outgoing only.

- Verify the hook on the running container:
  `docker exec waha env | grep WHATSAPP_HOOK`.
- Do **not** verify with `GET /api/sessions/<name>`. It reports `"webhooks": []`
  even while a working hook is configured, because it lists per-session hooks
  only; a `WHATSAPP_HOOK_URL` applies container-wide and never appears there.
- WAHA's sample `.env` ships `WHATSAPP_HOOK_URL`, `WHATSAPP_HOOK_EVENTS` and
  `WHATSAPP_HOOK_CUSTOM_HEADERS` commented out with placeholder values. Grepping
  the file finds three hits and suggests they are configured; they are not.
- Confirm that WAHA can reach the notifier over a shared Docker network:
  `docker exec waha wget -qO- http://<notifier>:3000/health`.
- `WAHA_WEBHOOK_SECRET` must be identical on both sides. A mismatch is answered
  with HTTP 403 by the notifier and likewise produces no chat message.
- The notifier log distinguishes the two cases: a delivered but rejected request
  logs `unlock_ignored_wrong_context` or `unlock_rejected_invalid_webhook`,
  whereas undelivered replies leave no entry at all.
