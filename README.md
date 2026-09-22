# HHG Villa GW / iLifestyle self-hosted integration

Experimental, unofficial local integration for the HHG Villa GW AV-Link gateway. The tested path combines local SIP, MQTT and RTSP:

1. the gateway calls a local Baresip endpoint;
2. the service detects the incoming call and captures an RTSP frame;
3. the current notifier uses WAHA to send the image to a WhatsApp group;
4. when explicitly enabled and authorized, a reply accepts the same SIP call and publishes one non-retained MQTT `OPEN DOOR` command.

The local ring/video/control path worked without the iLifestyle cloud in the tested setup. First-time provisioning, every firmware version and long-term operation without the vendor cloud have **not** yet been proven.

## Status

This branch is a sanitized release candidate, not a production release.

- Tested device: HHG Villa GW / AVL20P, firmware 4.1.5
- Local video: `rtsp://<gateway>/live.sdp`
- Ring detection: local incoming SIP call
- Door command: MQTT after accepting the matching SIP call
- Door selection and multi-door behavior: not generalized yet
- WhatsApp: required by the current notifier and dependent on WAHA and WhatsApp services
- ioBroker cloud script: retained under `integrations/iobroker` as a legacy, experimental implementation; its assumed `action: ring` event is unconfirmed

## Safety

Door opening is disabled by default. Enabling it requires both `UNLOCK_ENABLED=true` and either an explicit participant allow-list or the separate, deliberate `UNLOCK_ALLOW_WHOLE_GROUP=true` setting. Failed or ambiguous physical operations are consumed and never retried automatically.

Do not expose MQTT, Baresip control ports, WAHA or the health endpoint to the public Internet. Use distinct MQTT users with minimal ACLs.

## Repository layout

```text
services/doorbell/       notification and guarded unlock service
deploy/baresip/          local SIP endpoint examples
deploy/mosquitto/        broker configuration examples
integrations/iobroker/   legacy experimental ioBroker script
docs/                    architecture, setup and compatibility notes
```

## Migration from the legacy ioBroker script

The old `ilifestyle-iobroker.js` script did not work as described for the tested
AVL20P gateway:

- The script expected an MQTT `action: ring` message. That message was not seen
  in the tests, so the `doorbell` datapoint was not a reliable ring detector.
- The gateway ignored MQTT `OPEN DOOR` when there was no matching accepted SIP
  call, so the `open_door` datapoint did not reliably open the door.
- The script used the vendor cloud MQTT service and was not cloud-independent.

Sanitized copies of the old scripts remain in `integrations/iobroker/` for
reference. They are marked as legacy and are not the recommended installation.

The replacement uses the incoming SIP call as the ring event. It captures the
image through local RTSP. It sends one MQTT door command only after Baresip has
accepted the same call. Existing ioBroker datapoints and automations are not
migrated automatically.

There is no ready-to-use Compose deployment yet. Follow `docs/setup.md` and keep
door opening disabled until the complete path works with your hardware.

## Installation

The reusable deployment is still being converted from a working private setup. Start with [docs/setup.md](docs/setup.md). Do not enable the door actuator until the SIP, MQTT and authorization checks have been validated with your hardware.

## Scope and licensing

Only original integration code and documentation belong in this repository. Vendor firmware, extracted Lua files, databases, packet captures, device backups, credentials and private deployment data are intentionally excluded.

This project is not affiliated with or endorsed by HHG or the iLifestyle service. Use at your own risk. Original project code is licensed under MIT.
