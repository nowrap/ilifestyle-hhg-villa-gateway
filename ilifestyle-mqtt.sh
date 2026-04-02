#!/bin/bash
# ilifestyle-mqtt.sh
# Connects to the iLifestyle Cloud MQTT broker for HHG Villa GW AV-Link Gateway (AVL20P)
# Fetches a fresh token from the local gateway API and subscribes to doorbell events.
#
# Usage: ./ilifestyle-mqtt.sh
# Requirements: mosquitto-clients, curl, python3

# ─── Configuration ────────────────────────────────────────────────────────────
AVL_IP="192.168.0.14"       # IP address of your AVL20P gateway
AVL_USER="admin"             # Gateway web UI username
AVL_PASS="admin"             # Gateway web UI password
MQTT_HOST="de.ilifestyle-cloud.com"
MQTT_PORT="1883"
CLIENT_ID_PREFIX="ioBroker"
# ──────────────────────────────────────────────────────────────────────────────

echo "🔑 Fetching login token from gateway..."
LOGIN_TOKEN=$(curl -s -X POST "http://$AVL_IP/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$AVL_USER\",\"password\":\"$AVL_PASS\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token']) if d.get('status')==0 else exit(1)" 2>/dev/null)

if [ -z "$LOGIN_TOKEN" ]; then
  echo "❌ Login failed. Check AVL_IP, AVL_USER and AVL_PASS."
  exit 1
fi

echo "☁️  Fetching cloud token..."
CLOUD_TOKEN=$(curl -s "http://$AVL_IP/api/account" \
  --cookie "token=$LOGIN_TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['token']) if d.get('status')==0 else exit(1)" 2>/dev/null)

if [ -z "$CLOUD_TOKEN" ]; then
  echo "❌ Failed to get cloud token."
  exit 1
fi

echo "📡 Fetching device ID..."
DEVICE_ID=$(curl -s "http://$AVL_IP/api/mac" \
  --cookie "token=$LOGIN_TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['mac'].replace(':','')) if d.get('status')==0 else exit(1)" 2>/dev/null)

if [ -z "$DEVICE_ID" ]; then
  echo "❌ Failed to get device ID."
  exit 1
fi

echo "✅ Device: $DEVICE_ID"
echo "🔌 Connecting to MQTT broker $MQTT_HOST:$MQTT_PORT ..."
echo "📬 Subscribing to topic: $DEVICE_ID/#"
echo ""

mosquitto_sub \
  -h "$MQTT_HOST" \
  -p "$MQTT_PORT" \
  -u "$DEVICE_ID" \
  -P "$CLOUD_TOKEN" \
  -i "$CLIENT_ID_PREFIX|$DEVICE_ID" \
  -t "$DEVICE_ID/#" \
  -v
