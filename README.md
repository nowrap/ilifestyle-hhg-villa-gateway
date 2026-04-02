# ilifestyle-hhg-villa-gateway

Unofficial ioBroker integration for the **HHG Villa GW AV-Link Gateway (AVL20P)** via iLifestyle Cloud MQTT.

Tested with: HHG Villa GW AV-Link Gateway, Firmware 4.1.5

> 📝 **Note:** The existing [hass-ilifestyle](https://github.com/timniklas/hass-ilifestyle) integration targets the HHG Villa GW M (AV-Link 4.0.2). This project targets the larger **HHG Villa GW AV-Link Gateway (AVL20P)** which uses a different firmware and HTTP API.

---

## Features

- 🔔 Doorbell event detection via MQTT
- 📷 Camera/monitor state tracking
- 🚪 Remote door open trigger
- 📡 Automatic token refresh from local gateway API
- 🔗 ioBroker datapoints for easy automation
- 🐚 Standalone shell script for testing and debugging

---

## Hardware

| Product | Internal model | Firmware |
|---------|---------------|---------|
| HHG Villa GW AV-Link Gateway | AVL20P | 4.1.x |
| HHG Villa GW M *(not this project)* | AV-Link | 4.0.x |

---

## How it works

The AVL20P connects to the iLifestyle Cloud MQTT broker. Credentials are fetched dynamically from the gateway's local HTTP API — no hardcoded tokens required. When someone rings the doorbell, an MQTT message is published on the device's topic.

```
Doorbell press
    → AVL20P publishes MQTT event to iLifestyle Cloud
        → ioBroker script receives event
            → sets ilifestyle.doorbell = true
                → trigger your automations (push notification, lights, etc.)
```

---

## Installation

### 1. Requirements

- ioBroker with **javascript** adapter installed
- Gateway reachable on local network

### 2. ioBroker Script

- Open ioBroker Admin → Scripts → JavaScript
- Create a new script
- Paste the contents of `ilifestyle-iobroker.js`
- Adjust the configuration block at the top:

```javascript
const AVL_IP    = '192.168.0.14';  // IP of your AVL20P
const AVL_USER  = 'admin';          // Gateway web UI username
const AVL_PASS  = 'admin';          // Gateway web UI password
```

- Save and start the script

### 3. Verify

Check the ioBroker log for:
```
iLifestyle: device=YOUR_DEVICE_ID
iLifestyle: MQTT connected
iLifestyle: subscribed to YOUR_DEVICE_ID/#
```

---

## Datapoints

All datapoints are created under `javascript.0.ilifestyle.*`

| Datapoint | Type | R/W | Description |
|-----------|------|-----|-------------|
| `connected` | boolean | R | MQTT connection state |
| `doorbell` | boolean | R | `true` for 5s when doorbell is pressed |
| `camera_active` | boolean | R | `true` when camera stream is active |
| `open_door` | boolean | R/W | Set to `true` to trigger door opener |
| `rtmp_url` | string | R | RTMP stream URL |
| `last_event` | string | R | Last raw MQTT payload |

---

## Example Automations

### Push notification on doorbell (Telegram)

```javascript
on({ id: 'javascript.0.ilifestyle.doorbell', val: true }, () => {
    sendTo('telegram.0', 'send', {
        text: '🔔 Jemand klingelt!',
        chatId: 'YOUR_CHAT_ID'
    });
});
```

### Open door via VIS button

Set datapoint `javascript.0.ilifestyle.open_door` to `true` via a VIS button widget.

---

## Shell Script (Testing)

`ilifestyle-mqtt.sh` is a standalone bash script for testing the MQTT connection and inspecting raw events.

```bash
chmod +x ilifestyle-mqtt.sh
./ilifestyle-mqtt.sh
```

**Requirements:** `mosquitto-clients`, `curl`, `python3`

---

## Known MQTT Payloads

| Event | Payload |
|-------|---------|
| Doorbell ring | `{"action":"ring","key_index":1}` *(to be confirmed)* |
| Camera on | `{"action":"monitor","ctrl":"1","key_index":1,"duration":60}` |
| Camera off | `{"action":"monitor","ctrl":"F","key_index":1,"duration":1}` |
| Door open | `{"action":"OPEN DOOR"}` |
| Sync | `{"action":"SYNC"}` |

---

## Related Projects

- [hass-ilifestyle](https://github.com/timniklas/hass-ilifestyle) — Home Assistant integration for HHG Villa GW M

---

## Disclaimer

This project is not affiliated with or endorsed by HHG GmbH. Use at your own risk.

## License

MIT
