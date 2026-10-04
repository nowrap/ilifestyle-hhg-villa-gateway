# Compatibility and evidence

| Capability | Tested status |
|---|---|
| Local RTSP snapshot | Confirmed on AVL20P firmware 4.1.5 |
| Incoming local SIP call | Confirmed |
| WhatsApp image via WAHA | Confirmed, required by the current notifier |
| MQTT `OPEN DOOR` without call context | Rejected by gateway in observed test |
| Accept matching SIP call, then MQTT `OPEN DOOR` | Confirmed in tested setup |
| MQTT `action: ring` event | Unconfirmed |
| Multi-door selection | Not generalized |
| Configuration survives a gateway reboot | No on AVL20P firmware 4.1.5: the boot overwrites it from the vendor cloud |
| Cold start without vendor cloud | Acceptance test pending, and see the note below |
| Long-term fully cloud-free operation | Acceptance test pending |

## Note on reboots and cold start

A reboot of the tested gateway is not neutral. While booting, the device fetches
its configuration from the vendor cloud and writes it to
`/customer/share/avl20.db`, replacing locally set SIP and MQTT targets. This was
observed with nobody touching the vendor app or its web interface: the boot time
derived from `uptime` and the modification time of the database fell in the same
minute.

Two consequences for anyone testing cold start without the vendor cloud:

- Restoring the targets does not need a reboot. A configuration reload is
  enough, and a reboot would undo the change.
- On the tested device the MQTT password presented after such a round trip
  differed from the one used before, although the token stored in the device
  database was unchanged across the whole period. Plan for re-establishing the
  credential, not only the endpoint.

Whether a gateway that cannot reach the vendor cloud at boot keeps its local
configuration, or instead waits indefinitely for a discovery answer, is
untested. Four short connections that closed before sending MQTT CONNECT were
observed immediately after one such boot. They are consistent with the second
case but do not establish it.
