#!/usr/bin/env bash
set -e

echo "========================================================================="
echo "🍓 THUZHAYAN — Raspberry Pi 5 Physical AI Setup & Launch Script"
echo "========================================================================="

# 1. Serial & GPIO Permissions
echo "--> Configuring hardware permissions for serial & GPIO access..."
sudo usermod -a -G dialout,gpio $USER 2>/dev/null || true

# 2. Check / Install Python Dependencies
echo "--> Installing Python dependencies (pymavlink, pyserial, gpiozero)..."
python3 -m venv .venv 2>/dev/null || true
source .venv/bin/activate 2>/dev/null || true
pip install --quiet pymavlink pyserial gpiozero

# 3. Check / Install Ollama for Gemma Edge AI Model
if ! command -v ollama &> /dev/null; then
    echo "--> Installing Ollama for local Gemma 2B Edge AI inference on Raspberry Pi 5..."
    curl -fsSL https://ollama.com/install.sh | sh || echo "Ollama install skipped or requires manual confirmation."
fi

# 4. Pull Gemma model if Ollama is running and no Gemma model is found
if command -v ollama &> /dev/null; then
    if ollama list 2>/dev/null | grep -iE "gemma.*(1b|2b)" > /dev/null; then
        echo "--> Found existing local Gemma model installed in Ollama."
    else
        echo "--> Pulling Gemma 1B model for high-speed edge AI coaching on Raspberry Pi 5..."
        ollama pull gemma:1b || echo "Ollama daemon not running yet. Run 'ollama serve' in background if needed."
    fi
fi

echo ""
echo "========================================================================="
echo "✅ Raspberry Pi 5 Setup Complete!"
echo "========================================================================="
echo ""
echo "🚀 HOW TO RUN ON RASPBERRY PI 5:"
echo ""
echo "OPTION A — Single All-In-One Launcher (Recommended):"
echo "   ./run_raspi5_all.sh"
echo ""
echo "OPTION B — Individual Terminal Commands:"
echo "1. Start MAVLink Boat Telemetry Service:"
echo "   PYTHONPATH=\"\$PWD/work/ardupilot/modules/mavlink:\$PWD/work/python-packages\" \\"
echo "     python3 boat_telemetry/sitl_reader.py --connection auto"
echo ""
echo "2. Start Paddler Hardware Telemetry Service (HTTP http://192.168.11.219/):"
echo "   python3 paddle_telemetry/paddle_reader.py --url http://192.168.11.219/"
echo ""
echo "3. Start Live Dashboard & Gemma/Gemini Web Server:"
echo "   python3 boat_telemetry/live_dashboard.py --port 8080"
echo ""
echo "4. Open Browser:"
echo "   http://127.0.0.1:8080 (or http://<RASPI_IP_ADDRESS>:8080)"
echo "========================================================================="
