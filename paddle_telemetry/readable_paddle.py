#!/usr/bin/env python3
"""Readable Paddler Telemetry Formatter: Converts raw HTTP JSON from http://192.168.11.219/ into a readable format."""

import argparse
import json
import math
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


def format_paddler_data(data: dict, compact: bool = False) -> str:
    device_name = data.get("device_name", "PADDLER-1")
    paddler_id = data.get("paddler_id", data.get("paddle_id", 1))
    ip = data.get("ip", "192.168.11.219")
    rssi = data.get("wifi_rssi", -65)
    temp_c = data.get("temp_c", 0.0)
    
    # Support both raw hardware JSON and normalized JSONL keys
    accel_mag = data.get("accel_magnitude_g", data.get("peak_accel_g", 0.0))
    accel = data.get("accel_g", {})
    ax = accel.get("x", 0.0)
    ay = accel.get("y", 0.0)
    az = accel.get("z", 0.0)

    gyro = data.get("gyro_dps", {})
    gx = gyro.get("x", 0.0)
    gy = gyro.get("y", 0.0)
    gz = gyro.get("z", 0.0)

    orient = data.get("orientation_deg", {})
    roll = orient.get("roll", data.get("roll_deg", 0.0))
    pitch = orient.get("pitch", data.get("pitch_deg", 0.0))
    yaw = orient.get("yaw_relative", data.get("yaw_deg", 0.0))

    spm = data.get("stroke_rate_spm", 0.0)
    tilted = data.get("tilted", False)
    buttons = data.get("buttons", {})
    a0 = buttons.get("a0", data.get("button_a0", False))
    a1 = buttons.get("a1", data.get("button_a1", False))
    
    # Signal quality text
    if rssi >= -65:
        signal_str = f"{rssi} dBm (Strong Signal 📶)"
    elif rssi >= -75:
        signal_str = f"{rssi} dBm (Fair Signal 📶)"
    else:
        signal_str = f"{rssi} dBm (Weak Signal ⚠️)"

    if compact:
        timestamp = time.strftime("%H:%M:%S")
        tilt_str = "🚨 TILT ALERT" if tilted else "OK"
        btn_str = f"A0:{'ON' if a0 else 'OFF'} A1:{'ON' if a1 else 'OFF'}"
        return (
            f"[{timestamp}] 🚣 {device_name} ({ip}) | "
            f"Accel: {accel_mag:.2f}g (X:{ax:+.2f} Y:{ay:+.2f} Z:{az:+.2f}) | "
            f"Roll: {roll:+.1f}° Pitch: {pitch:+.1f}° Yaw: {yaw:.1f}° | "
            f"GyroX: {gx:+.1f}°/s | Temp: {temp_c:.1f}°C | RSSI: {rssi}dBm | Tilt: {tilt_str} | {btn_str}"
        )

    lines = [
        "========================================================================",
        f"🚣 THUZHAYAN PADDLE TELEMETRY READOUT — {device_name} (ID: #{paddler_id})",
        "========================================================================",
        f"📡 IP Address      : {ip}  [{signal_str}]",
        f"🌡️ Temperature     : {temp_c:.1f} °C",
        f"⚡ Total Acceleration: {accel_mag:.3f} g",
        f"   └─ X-Axis (Pitch): {ax:+.3f} g",
        f"   └─ Y-Axis (Roll) : {ay:+.3f} g",
        f"   └─ Z-Axis (Vert) : {az:+.3f} g",
        f"🔄 Gyroscope Rotation:",
        f"   └─ Pitch Rate (Gx): {gx:+.2f} °/s",
        f"   └─ Roll Rate  (Gy): {gy:+.2f} °/s",
        f"   └─ Yaw Rate   (Gz): {gz:+.2f} °/s",
        f"📐 Blade Orientation:",
        f"   └─ Roll  : {roll:+.2f}° ({'Leaning Right' if roll > 3 else 'Leaning Left' if roll < -3 else 'Level'})",
        f"   └─ Pitch : {pitch:+.2f}° ({'Blade Up' if pitch > 3 else 'Blade Down' if pitch < -3 else 'Flat'})",
        f"   └─ Yaw   : {yaw:.2f}°",
        f"⚠️ Tilt Safety Status: {'🚨 TILT EXCEEDED' if tilted else '✅ NORMAL (Nominal)'}",
        f"🔘 Hardware Buttons : A0 = {'PRESSED [🔴]' if a0 else 'RELEASED [⚪]'} | A1 = {'PRESSED [🔴]' if a1 else 'RELEASED [⚪]'}",
        "========================================================================",
    ]
    return "\n".join(lines)


def fetch_from_url(url: str, timeout: float = 2.5) -> dict | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ThuzhayanPaddleReader/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8").strip()
            return json.loads(raw)
    except Exception as err:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Read and format paddler sensor data from http://192.168.11.219/")
    parser.add_argument("--url", default="http://192.168.11.219/", help="Paddler HTTP endpoint URL")
    parser.add_argument("--file", help="Path to local JSON file or JSONL telemetry log")
    parser.add_argument("--continuous", action="store_true", help="Continuously poll and display live readings")
    parser.add_argument("--interval", type=float, default=1.0, help="Polling interval in seconds for continuous mode")
    parser.add_argument("--compact", action="store_true", help="Display single line compact log output")
    args = parser.parse_args()

    if args.file:
        path = Path(args.file)
        if not path.exists():
            print(f"Error: File {args.file} not found.")
            sys.exit(1)
        with path.open(encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]
            if not lines:
                print("File is empty.")
                sys.exit(1)
            raw = lines[-1]
            data = json.loads(raw)
            print(format_paddler_data(data, compact=args.compact))
        return

    print(f"Fetching live paddler data from {args.url}...\n")
    if args.continuous:
        print(f"Starting continuous polling (interval: {args.interval}s, press Ctrl+C to stop)...")
        try:
            while True:
                data = fetch_from_url(args.url)
                if data:
                    print(format_paddler_data(data, compact=args.compact))
                    if not args.compact:
                        print()
                else:
                    print(f"[{time.strftime('%H:%M:%S')}] ⚠️ Waiting for paddler hardware response at {args.url}...")
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\nStopped paddler monitor.")
    else:
        data = fetch_from_url(args.url)
        if data:
            print(format_paddler_data(data, compact=args.compact))
        else:
            print(f"Could not connect to paddler endpoint at {args.url}.")
            sys.exit(1)


if __name__ == "__main__":
    main()
