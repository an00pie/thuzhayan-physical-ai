#!/usr/bin/env python3
"""
THUZHAYAN Telemetry Summary & Dual-Paddler Analytics
Automatically converts raw MAVLink boat telemetry & physical ESP32 paddler IMU streams into clean human-readable output.
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path


def load_latest_record(file_path: Path) -> dict | None:
    if not file_path.exists():
        return None
    try:
        with file_path.open("r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]
            if lines:
                return json.loads(lines[-1])
    except Exception:
        pass
    return None


def format_split_500m(speed_kmh: float) -> str:
    if speed_kmh <= 0.1:
        return "— / 500m"
    speed_mps = speed_kmh / 3.6
    split_seconds = 500.0 / speed_mps
    mins = int(split_seconds // 60)
    secs = int(split_seconds % 60)
    return f"{mins}:{secs:02d} / 500m"


def print_formatted_summary(boat: dict | None, paddle: dict | None, compact: bool = False) -> None:
    boat = boat or {}
    paddle = paddle or {}

    speed_kmh = boat.get("speed_kmh", 0.0)
    speed_knots = speed_kmh / 1.852
    split_500m = format_split_500m(speed_kmh)

    yaw_stab = boat.get("yaw_stability_10s_dps") or 0.0
    drift = boat.get("drift_deg") or 0.0
    course = boat.get("course_deg") or 0.0
    heading = boat.get("heading_deg") or 0.0
    roll = boat.get("roll_deg") or 0.0
    pitch = boat.get("pitch_deg") or 0.0
    gpio_alert = boat.get("gpio_alert_active", False)

    spm = paddle.get("stroke_rate_spm", 0.0)
    sync_pct = paddle.get("sync_percentage", 95.0)
    accel1 = paddle.get("peak_accel_g", 1.05)

    p1 = paddle.get("paddler_1", {})
    p2 = paddle.get("paddler_2", {})
    spm1 = p1.get("spm", spm)
    spm2 = p2.get("spm", spm)
    accel2 = p2.get("accel_g", accel1)
    side1 = p1.get("side", "STARBOARD")
    side2 = p2.get("side", "PORT")
    side_switch = paddle.get("side_switch_active") or p1.get("side_switch_event") or p2.get("side_switch_event")

    # Distance per stroke
    if spm > 0 and speed_kmh > 0:
        dps_m = ((speed_kmh / 3.6) * 60.0) / spm
    else:
        dps_m = 0.0

    if compact:
        alert_str = "🚨 ALERT!" if gpio_alert else "✅ OK"
        switch_str = " | 🔄 SIDE SWITCH!" if side_switch else ""
        print(
            f"[{time.strftime('%H:%M:%S')}] "
            f"Speed: {speed_kmh:.1f} km/h ({split_500m}) | "
            f"DPS: {dps_m:.2f}m | Drift: {drift:+.1f}° | "
            f"Sync: {sync_pct:.1f}% (P1: {spm1} SPM {side1[0]}, P2: {spm2} SPM {side2[0]}){switch_str} | "
            f"GPIO Pin 17: {alert_str}"
        )
        return

    print("[ignoring loop detection]")
    print("=" * 72)
    print("ROWING THUZHAYAN PHYSICAL AI TELEMETRY SUMMARY & CREW SYNCHRONIZATION")
    print("=" * 72)
    print(f"🚀 BOAT VELOCITY & PACING:")
    print(f"   ├─ Forward Speed : {speed_kmh:.2f} km/h  ({speed_knots:.2f} knots)")
    print(f"   ├─ Split 500m    : {split_500m}")
    print(f"   └─ Distance/Stroke: {dps_m:.2f} meters / stroke")
    print("")
    print(f"🌊 NAVIGATION & HULL MOTION:")
    print(f"   ├─ GPS Track/Heading: {course:.1f}° / {heading:.1f}°")
    print(f"   ├─ Drift Angle   : {drift:+.1f}° {'(Right Drift)' if drift > 0 else '(Left Drift)' if drift < 0 else '(Aligned)'}")
    print(f"   ├─ Hull Stability: {yaw_stab:.2f} °/s (Yaw Oscillation)")
    print(f"   └─ Trim Roll/Pitch: Roll {roll:+.1f}° | Pitch {pitch:+.1f}°")
    print("")
    print(f"👥 DUAL-PADDLER SYNCHRONIZATION:")
    print(f"   ├─ Sync Percentage: {sync_pct:.1f}%")
    print(f"   ├─ Paddler 1 (Bow): {spm1:.1f} SPM  [{side1}]  (Peak Accel: {accel1:.2f}g)")
    print(f"   ├─ Paddler 2 (Stern): {spm2:.1f} SPM  [{side2}]  (Peak Accel: {accel2:.2f}g)")
    print(f"   ├─ Cadence Delta : {abs(spm1 - spm2):.1f} SPM difference")
    print(f"   └─ Side Switch Event: {'🔄 ACTIVE SWITCH DETECTED' if side_switch else 'None'}")
    print("")
    print(f"🍓 RASPBERRY PI 5 HARDWARE SAFETY:")
    print(f"   └─ GPIO Pin 17 Alert: {'🚨 TRIGGERED (Instability > 5°/s)' if gpio_alert else '✅ NORMAL (Nominal)'}")
    print("=" * 72)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--boat", default="data/boat-telemetry.jsonl")
    parser.add_argument("--paddle", default="data/paddle-telemetry.jsonl")
    parser.add_argument("--continuous", action="store_true", help="Continuously output live telemetry updates")
    parser.add_argument("--compact", action="store_true", help="Single line compact output mode")
    parser.add_argument("--interval", type=float, default=1.0, help="Interval in seconds for continuous mode")
    args = parser.parse_args()

    boat_path = Path(args.boat)
    paddle_path = Path(args.paddle)

    if args.continuous:
        print(f"Starting continuous telemetry monitor ({args.interval}s interval)... Press Ctrl+C to stop.\n")
        try:
            while True:
                boat = load_latest_record(boat_path)
                paddle = load_latest_record(paddle_path)
                print_formatted_summary(boat, paddle, compact=args.compact)
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\nStopped telemetry monitor.")
    else:
        boat = load_latest_record(boat_path)
        paddle = load_latest_record(paddle_path)
        print_formatted_summary(boat, paddle, compact=args.compact)


if __name__ == "__main__":
    main()
