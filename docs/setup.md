# Setup (release-candidate notes)

This is not yet a one-command installation. A clean-room Compose setup is being prepared and must not inherit private DNS, Traefik or host-network assumptions.

Required components:

- Mosquitto 2 with anonymous access disabled, separate gateway/notifier users, and ACLs restricted to the configured device topic;
- Baresip listening on the host LAN address used by the gateway call target;
- WAHA with API authentication (required by the current notifier);
- the doorbell service from `services/doorbell`;
- FFmpeg access to `rtsp://<gateway>/live.sdp`.

Use the Baresip instance only for this gateway and configure exactly one
account. The example limits it to one simultaneous call. Additional accounts or
unrelated calls invalidate the call-inventory assumptions and are unsupported.

Baresip `ctrl_tcp` is an unauthenticated command interface. Keep it on
`127.0.0.1`; never publish port 4444 to the LAN. Until the Compose deployment is
provided, run Baresip and the notifier in the same network namespace (for
example host networking on a dedicated host) so the notifier can reach that
loopback address. Do not solve connectivity by changing `ctrl_tcp_listen` to
`0.0.0.0`.

The example uses host ports 3002 for WAHA and 3003 for the notifier. Adjust both
URLs together if your deployment maps different ports.

`POST /doorbell` is a compatibility input for an external SIP observer. It
requires `X-Ilifestyle-Secret: <WEBHOOK_SECRET>` and accepts only fresh JSON
events with `event="doorbell"` and `source="sip-invite"`. The preferred event
source is the local Baresip control connection.

Copy `.env.example` to `.env`, replace every placeholder, and initially keep `UNLOCK_ENABLED=false`. Validate ring detection and image delivery before enabling any physical action.

The gateway-facing MQTT listener may require TLS termination depending on its configuration. Do not assume that an unauthenticated port 1883 listener is an acceptable substitute.
