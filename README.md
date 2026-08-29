# 🚣 THUZHAYAN — Physical AI Boat & Dual-Paddle Telemetry System

> **Real-Time Hydrodynamic Sensor Fusion, Dual-Paddler Synchronization Analytics, & Edge AI Coaching on Raspberry Pi 5**

---

## 👥 Team & Project Information

- **Team Name**: Hardwired
- **Team Members**: 
  - **Anoop Danimon**
  - **Sreeram R**
  - **Soorya**
  - **Aryan Baburaj**
- **Hardware Platform**: Raspberry Pi 5 (8GB) + ArduPilot MAVLink Flight Controller + ESP32 IMU Wireless Sensor Hubs

---

## 🌟 Overview & Key Features

**THUZHAYAN** is a physical AI telemetry and real-time athletic coaching stack engineered for competitive rowing shells and motorboats. By combining high-frequency hardware IMUs, GPS flight telemetry, edge AI models, and cloud analytics, THUZHAYAN delivers instantaneous feedback on crew synchronization, hull drag, and pacing.

### Key Capabilities:
- ⛵ **MAVLink Boat Telemetry**: Computes forward speed (km/h & knots), Split 500m pace (`MM:SS / 500m`), GPS course vs. compass heading drift angle (`°`), and 10-second rolling yaw stability index (`°/s`).
- 🚣 **Dual-Paddler Wireless IMU Hub**: Reads physical 3-axis accelerometer and gyroscope data from `PADDLER-1` (`http://192.168.11.219/`) and `PADDLER-2` (`http://192.168.11.220/`).
- 👥 **Crew Synchronization Engine**: Calculates real-time catch phase alignment ($0-100\%$), cadence divergence ($\Delta \text{SPM}$), and Distance Per Stroke ($\text{DPS}$ in meters/stroke).
- 🤖 **Local Gemma Edge AI Coach**: Runs an edge-optimized Gemma model (`gemma3:4b` / `gemma:2b` via Ollama) locally on Raspberry Pi 5 to issue immediate tactical corrections (e.g. blade slipping, port/starboard imbalance).
- ☁️ **Google Cloud Gemini API**: Processes session log archives to output executive post-run hydrodynamic efficiency scores and structured crew training plans.
- 🚨 **Physical Hardware Safety Alert**: Direct Raspberry Pi 5 **GPIO Pin 17** physical trigger when hull instability or excessive roll lean ($>15^\circ$) is detected.
- 🌊 **Interactive Web Dashboard**: Animated SVG racing shell with synchronized dual rowers dipping oars and water splash rings reacting to live stroke frequency on Port `8080`.

---

## 🏗 System Architecture

```
                               ┌─────────────────────────────────────────┐
                               │     ESP32 Paddler 1 Wireless Hub        │
                               │        (http://192.168.11.219/)         │
                               └────────────────────┬────────────────────┘
                                                    │ HTTP Telemetry Stream
                                                    ▼
┌───────────────────────────────┐     ┌───────────────────────────────────┐     ┌───────────────────────────────┐
│  MAVLink Boat FC (ArduPilot)  │────►│       RASPBERRY PI 5 CORE         │◄────│     ESP32 Paddler 2 Hub       │
│  GPS, Heading, Roll/Pitch/Yaw │     │ (Physical AI Ingestion Loop)      │     │   (http://192.168.11.220/)    │
└───────────────────────────────┘     └─────────────────┬─────────────────┘     └───────────────────────────────┘
                                                        │
                         ┌──────────────────────────────┴──────────────────────────────┐
                         ▼                                                             ▼
         ┌───────────────────────────────┐                             ┌───────────────────────────────┐
         │     Local Gemma Edge AI       │                             │   Physical GPIO Hardware      │
         │  (Ollama RPi 5 Edge Coach)    │                             │  (GPIO Pin 17 Alert LED/Buzzer)
         └───────────────┬───────────────┘                             └───────────────────────────────┘
                         │
                         ▼
         ┌───────────────────────────────┐                             ┌───────────────────────────────┐
         │  Live Dashboard & SVG Anim    │                             │   Google Cloud Gemini API     │
         │       (HTTP Port 8080)        │                             │    (Deep Session Analytics)   │
         └───────────────────────────────┘                             └───────────────────────────────┘
```

---

## 📊 Telemetry Metrics Breakdown

| Category | Metric | Calculation / Hardware Origin | Tactical Meaning |
| :--- | :--- | :--- | :--- |
| **Velocity** | Forward Speed | MAVLink GPS ($V_x, V_y$) | Instantaneous over-water velocity (`km/h` / `knots`). |
| **Pacing** | Split 500m | $500 / \text{speed\_mps}$ | Standard rowing pace benchmark (`MM:SS / 500m`). |
| **Navigation**| Course Drift | $\text{GPS Course} - \text{Compass Heading}$ | Quantifies cross-wind or current drift angle (`°`). |
| **Hull Motion**| Yaw Stability | 10s StdDev of Yaw Rotation Rate | Quantifies **wasted lateral kinetic energy** (`°/s`). |
| **Paddlers** | Sync Score | Phase Alignment & $\Delta \text{SPM}$ | Crew rhythm synchronization ($0-100\%$). |
| **Efficiency**| Distance/Stroke | $(\text{Speed\_mps} \times 60) / \text{Avg SPM}$ | Forward distance gained per stroke drive ($m/\text{stroke}$). |

---

## 🚀 Quickstart & Deployment Guide

### 1. Hardware Permissions & Dependencies Setup

Run the automated Raspberry Pi 5 environment configuration script:

```bash
./setup_raspi5_sh
```

### 2. Single Master Launch (Recommended)

Start all Physical AI services (MAVLink telemetry reader, ESP32 dual-paddler polling, Gemma edge engine, and Web Dashboard) with a single command:

```bash
./run_raspi5_all.sh
```

### 3. Open Live Dashboard

Access the real-time animated web dashboard:
- **Local on Pi**: `http://127.0.0.1:8080`
- **Network Access**: `http://<RASPI_IP_ADDRESS>:8080`

### 4. CLI Automatic Telemetry Summary Tool

To view instant formatted telemetry reports in the terminal:

```bash
# Instant formatted report
python3 boat_telemetry/readable_summary.py

# Continuous live streaming status bar
python3 boat_telemetry/readable_summary.py --continuous --compact
```

---

## 📂 Repository File Structure

```text
.
├── boat_telemetry/
│   ├── sitl_reader.py          # MAVLink ArduPilot boat telemetry service & GPIO 17 trigger
│   ├── gemma_advisor.py        # Local Gemma Edge AI model integration & heuristics
│   ├── cloud_gemini_analyst.py # Google Cloud Gemini API session analytics
│   ├── live_dashboard.py       # Web server API & dashboard controller (Port 8080)
│   ├── live_dashboard.html     # Live UI with SVG animated dual-paddler rowing shell
│   ├── readable_summary.py     # Automatic telemetry & synchronization report tool
│   └── final_report.py         # Overall telemetry session statistics logger
├── paddle_telemetry/
│   ├── paddle_reader.py        # Dual ESP32 paddler HTTP polling (192.168.11.219 & .220)
│   └── readable_paddle.py      # Individual paddler IMU readout utility
├── run_raspi5_all.sh           # Master launcher script for Raspberry Pi 5
├── setup_raspi5.sh             # Dependencies setup & Ollama Gemma installer
└── README.md                   # System documentation
```

---

## 🏆 Credits & License

Built by Team **Hardwired** (Anoop Danimon, Sreeram R, Soorya, Aryan Baburaj) for competitive watercraft performance analysis and Physical AI integration.
