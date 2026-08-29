#!/usr/bin/env bash
# =========================================================================
# 🍓 THUZHAYAN — Raspberry Pi 5 All-In-One Physical AI Master Launcher
# =========================================================================

set -e

# Set working directory to repository root
WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$WORKSPACE_DIR"

export PYTHONPATH="$WORKSPACE_DIR/work/ardupilot/modules/mavlink:$WORKSPACE_DIR/work/python-packages:$PYTHONPATH"

# Create data directory if it doesn't exist
mkdir -p data

echo "========================================================================="
echo "🍓 THUZHAYAN Physical AI System — Launching on Raspberry Pi 5"
echo "========================================================================="
echo "📍 Workspace Path : $WORKSPACE_DIR"
echo "🚣 Paddler 1 IP   : http://192.168.11.240/"
echo "🚣 Paddler 2 IP   : http://192.168.11.219/"
echo "🤖 Edge AI Model   : Local Gemma 1B (Ollama RPi 5 Edge Engine)"
echo "☁️ Cloud Analytics : Google Cloud Gemini API"
echo "========================================================================="
echo ""

# Export local Gemma 1B model preference for RPi 5
export GEMMA_MODEL="${GEMMA_MODEL:-gemma:1b}"

# Cleanup background processes on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down Thuzhayan Physical AI services..."
    kill $(jobs -p) 2>/dev/null || true
    echo "Done."
}
trap cleanup EXIT INT TERM

# 1. Start MAVLink Boat Telemetry Service
echo "--> 1/3 Starting MAVLink Boat Telemetry Service (Serial Auto-Detect / SITL)..."
python3 boat_telemetry/sitl_reader.py --connection auto &
PID_BOAT=$!
sleep 1

# 2. Start Dual Paddler Hardware Telemetry Service (.240 & .219)
echo "--> 2/3 Starting Dual Paddler Hardware Reader (192.168.11.240 & 192.168.11.219)..."
python3 paddle_telemetry/paddle_reader.py --url1 http://192.168.11.240/ --url2 http://192.168.11.219/ &
PID_PADDLE=$!
sleep 1

# 3. Start Live Dashboard & Local Gemma AI Web Server
echo "--> 3/3 Starting Live Dashboard & Local Gemma Model Server (Port 8080)..."
echo "-------------------------------------------------------------------------"
echo "🌐 LIVE DASHBOARD READY AT:"
echo "   👉 http://127.0.0.1:8080"
echo "   👉 http://localhost:8080 (or your Raspberry Pi 5 IP)"
echo "-------------------------------------------------------------------------"

python3 boat_telemetry/live_dashboard.py --port 8080
