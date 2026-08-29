#!/usr/bin/env bash
# THUZHAYAN Physical AI - One-Click ESP32 / ESP8266 Flash Script
# Uses standalone arduino-cli (no GUI required)

set -e

PORT="${1:-/dev/ttyUSB0}"
SKETCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SKETCH_DIR/../work/arduino-cli"

if [ ! -f "$CLI" ]; then
    echo "❌ arduino-cli not found at $CLI"
    exit 1
fi

echo "========================================================"
echo "⚡ THUZHAYAN ESP FLASH TOOL"
echo "========================================================"
echo " • Sketch: $SKETCH_DIR/ESP_SoftAP_Telemetry.ino"
echo " • Port  : $PORT"
echo "========================================================"

# Auto-detect board or default to esp32:esp32:esp32
BOARD_FQBN="esp32:esp32:esp32"

echo "🔨 Compiling sketch..."
"$CLI" compile --fqbn "$BOARD_FQBN" "$SKETCH_DIR/ESP_SoftAP_Telemetry.ino"

echo "⚡ Flashing to ESP on $PORT..."
"$CLI" upload -p "$PORT" --fqbn "$BOARD_FQBN" "$SKETCH_DIR/ESP_SoftAP_Telemetry.ino"

echo "========================================================"
echo "✅ ESP successfully flashed in Hotspot (SoftAP) mode!"
echo " • Connect Wi-Fi to SSID: THUZHAYAN_PADDLE_1"
echo " • Wi-Fi Password        : thuzhayan123"
echo " • Hotspot IP Address   : 192.168.4.1"
echo "========================================================"
