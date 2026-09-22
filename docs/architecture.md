# Architecture

The verified local event source is an incoming SIP call, not a confirmed MQTT `ring` publication. Baresip keeps the call available while the service captures an RTSP frame and creates a short-lived authorization grant.

An authorized opening request is bound to the current doorbell generation and
the caller-supplied SIP Call-ID carried by Baresip `ctrl_tcp` events. A new `CALL_INCOMING`,
`CALL_CLOSED`, missing active call or control disconnect immediately revokes the
previous grant. Before accept, MQTT publish and hangup, the service requires
that Call-ID to remain current and the event tracker to contain exactly one active call.
It then publishes one non-retained `OPEN DOOR` message, waits briefly and hangs
up that same call. Baresip 1.1 or newer is required because `accept` and `hangup`
must target a Call-ID; the supplied image currently uses Debian trixie.

The supplied Baresip instance is deliberately dedicated to this integration:
one configured account and `call_max_calls 1`. Its `listcalls` response is used
only to reconcile the event tracker after startup or a control reconnect. Until
an authoritative zero-call result is observed, an unknown or collided call
inventory cannot create an unlock grant.

The service never derives filesystem names directly from SIP headers. Snapshot
names contain only a truncated SHA-256 digest of the local event identifier.

The broker client-count metric is only a connectivity heuristic. Two connected clients do not cryptographically prove that one of them is the gateway.
