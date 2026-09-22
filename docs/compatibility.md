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
| Cold start without vendor cloud | Acceptance test pending |
| Long-term fully cloud-free operation | Acceptance test pending |
