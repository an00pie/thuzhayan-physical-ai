#!/usr/bin/env python3
"""Continuously normalize Rover/Boat MAVLink packets into boat telemetry JSONL."""

import argparse
import json
import math
import statistics
import time
from collections import deque
import glob
import os
import sys
from pathlib import Path

# Auto-resolve workspace pymavlink and python-packages search paths
workspace_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(workspace_dir / "work" / "ardupilot" / "modules" / "mavlink"))
sys.path.insert(0, str(workspace_dir / "work" / "python-packages"))

# pyrefly: ignore [missing-import]
from pymavlink import mavutil


def wrap_degrees(value: float) -> float:
    return (value + 180.0) % 360.0 - 180.0


def haversine_m(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    radius_m = 6_371_000.0
    lat_a, lon_a, lat_b, lon_b = map(math.radians, (lat_a, lon_a, lat_b, lon_b))
    dlat, dlon = lat_b - lat_a, lon_b - lon_a
    h = math.sin(dlat / 2) ** 2 + math.cos(lat_a) * math.cos(lat_b) * math.sin(dlon / 2) ** 2
    return 2 * radius_m * math.asin(math.sqrt(h))


def resolve_connection(connection_str: str) -> str:
    """Auto-detect physical hardware serial connections on Pi 5 / Linux if 'auto' is specified."""
    if connection_str != "auto":
        return connection_str
    candidates = (
        sorted(glob.glob("/dev/serial/by-id/*")) +
        sorted(glob.glob("/dev/ttyACM*")) +
        sorted(glob.glob("/dev/ttyUSB*")) +
        ["/dev/ttyAMA0"]
    )
    for path in candidates:
        if os.path.exists(path):
            print(f"Hardware Auto-Detect: Found physical flight controller on {path}")
            return path
    print("Hardware Auto-Detect: No physical serial connection found. Defaulting to UDP SITL (udpin:127.0.0.1:14550)")
    return "udpin:127.0.0.1:14550"


def update_raspi_gpio_alert(yaw_instability: float, roll_deg: float) -> bool:
    """Trigger physical Raspberry Pi 5 GPIO alert (GPIO 17) if instability threshold is exceeded."""
    alert_active = yaw_instability > 5.0 or abs(roll_deg) > 15.0
    try:
        from gpiozero import LED
        if not hasattr(update_raspi_gpio_alert, "_led"):
            update_raspi_gpio_alert._led = LED(17)
        if alert_active:
            update_raspi_gpio_alert._led.on()
        else:
            update_raspi_gpio_alert._led.off()
    except Exception:
        pass
    return alert_active


def request_rate(fc, message_id: int, rate_hz: float) -> None:
    """Ask ArduPilot for a message rate; normal telemetry still works if ignored."""
    fc.mav.command_long_send(
        fc.target_system,
        fc.target_component,
        mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
        0,
        message_id,
        int(1_000_000 / rate_hz),
        0, 0, 0, 0, 0,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--connection", default="auto", help="MAVLink connection URI or 'auto' for RPi 5 serial auto-detect")
    parser.add_argument("--output", default="data/boat-telemetry.jsonl")
    parser.add_argument("--source", default="ardupilot_mavlink")
    parser.add_argument("--seconds", type=int, default=0, help="0 runs until Ctrl+C")
    parser.add_argument("--truncate", action="store_true", help="Start a fresh JSONL log")
    args = parser.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    conn_str = resolve_connection(args.connection)
    print(f"Connecting to MAVLink hardware via: {conn_str}")
    fc = mavutil.mavlink_connection(conn_str)
    fc.wait_heartbeat(timeout=20)
    print(f"Connected to MAVLink system {fc.target_system}, component {fc.target_component}")

    for message_id, rate_hz in (
        (mavutil.mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, 10),
        (mavutil.mavlink.MAVLINK_MSG_ID_ATTITUDE, 10),
        (mavutil.mavlink.MAVLINK_MSG_ID_GPS_RAW_INT, 2),
        (mavutil.mavlink.MAVLINK_MSG_ID_SYS_STATUS, 1),
    ):
        request_rate(fc, message_id, rate_hz)

    latest = {}
    speed_samples = deque()
    yaw_samples = deque()
    previous_position = None
    distance_m = 0.0
    started = time.monotonic()
    next_frame = started

    mode = "w" if args.truncate else "a"
    with output.open(mode, encoding="utf-8") as log:
        while args.seconds == 0 or time.monotonic() - started < args.seconds:
            msg = fc.recv_match(blocking=True, timeout=1)
            now = time.monotonic()
            if msg is None:
                continue

            kind = msg.get_type()
            if kind == "GLOBAL_POSITION_INT":
                north_mps, east_mps = msg.vx / 100.0, msg.vy / 100.0
                speed_mps = math.hypot(north_mps, east_mps)
                # Direction at near-zero speed is numerical noise, not a boat course.
                course_deg = None if speed_mps < 0.2 else (math.degrees(math.atan2(east_mps, north_mps)) + 360) % 360
                heading_deg = None if msg.hdg == 65535 else msg.hdg / 100.0
                lat, lon = msg.lat / 1e7, msg.lon / 1e7

                if previous_position is not None:
                    step_m = haversine_m(*previous_position, lat, lon)
                    if step_m < 10:  # reject implausible GPS jumps
                        distance_m += step_m
                previous_position = (lat, lon)
                latest.update({
                    "speed_mps": speed_mps,
                    "speed_kmh": speed_mps * 3.6,
                    "course_deg": course_deg,
                    "heading_deg": heading_deg,
                    "drift_deg": None if heading_deg is None or course_deg is None else wrap_degrees(course_deg - heading_deg),
                    "latitude": lat,
                    "longitude": lon,
                })
                speed_samples.append((now, speed_mps))

            elif kind == "ATTITUDE":
                yaw_rate_dps = math.degrees(msg.yawspeed)
                latest.update({
                    "roll_deg": math.degrees(msg.roll),
                    "pitch_deg": math.degrees(msg.pitch),
                    "yaw_rate_dps": yaw_rate_dps,
                })
                yaw_samples.append((now, yaw_rate_dps))

            elif kind == "GPS_RAW_INT":
                latest.update({"gps_fix": msg.fix_type, "gps_satellites": msg.satellites_visible})

            elif kind == "SYS_STATUS":
                latest["battery_v"] = None if msg.voltage_battery == 65535 else msg.voltage_battery / 1000.0

            while speed_samples and now - speed_samples[0][0] > 10:
                speed_samples.popleft()
            while yaw_samples and now - yaw_samples[0][0] > 10:
                yaw_samples.popleft()

            if now >= next_frame and "speed_mps" in latest:
                speed_values = [value for _, value in speed_samples]
                yaw_values = [value for _, value in yaw_samples]
                rounded_latest = {
                    key: (round(value, 7) if key in {"latitude", "longitude"} else round(value, 2))
                    if isinstance(value, float) else value
                    for key, value in latest.items()
                }
                yaw_stab = round(statistics.pstdev(yaw_values), 2) if len(yaw_values) > 1 else 0.0
                gpio_alert = update_raspi_gpio_alert(yaw_stab, latest.get("roll_deg", 0.0))
                frame = {
                    "timestamp_unix_ms": int(time.time() * 1000),
                    "source": args.source,
                    "distance_m": round(distance_m, 2),
                    "speed_mps": round(latest["speed_mps"], 2),
                    "speed_kmh": round(latest["speed_kmh"], 2),
                    "speed_10s_avg_kmh": round(statistics.mean(speed_values) * 3.6, 2),
                    "yaw_stability_10s_dps": yaw_stab,
                    "gpio_alert_active": gpio_alert,
                    "gps_healthy": latest.get("gps_fix", 0) >= 3,
                    **rounded_latest,
                }
                log.write(json.dumps(frame) + "\n")
                log.flush()
                print(json.dumps(frame))
                next_frame = now + 1

    print(f"Wrote telemetry to {output}")


if __name__ == "__main__":
    main()
