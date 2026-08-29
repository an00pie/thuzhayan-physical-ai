#!/usr/bin/env python3
"""Paddle telemetry service: continuously reads dual physical paddler sensors and computes sync & efficiency.

Paddler 1: http://192.168.11.240/  (PADDLER-1)
Paddler 2: http://192.168.11.219/  (PADDLER-2)

Sensors stream a continuous JSON array of IMU readings at ~100Hz.
Each reading contains: accel_magnitude_g, orientation_deg (roll/pitch/yaw), gyro_dps, temp_c, etc.
"""

import argparse
import json
import math
import random
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


def fetch_http_paddle(url: str, timeout: float = 2.5) -> dict | None:
    """Fetch the latest IMU reading from a paddle sensor streaming endpoint.

    The sensors stream a continuous JSON array at ~100Hz — the connection
    never closes. We open an HTTP connection, read a fixed byte chunk
    containing recent readings, then forcibly close the socket.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ThuzhayanPaddleReader/1.0"})
        resp = urllib.request.urlopen(req, timeout=timeout)
        try:
            chunk = resp.read(8192).decode("utf-8", errors="replace").strip()
        finally:
            resp.close()

        # The chunk looks like: [{...},{...},{...},...  (continuous array, never closed)
        chunk = chunk.lstrip("[")

        # Split into individual JSON object strings
        parts = chunk.split("},{")
        if not parts:
            return None

        # Take the last *complete* object
        for candidate in reversed(parts):
            candidate = candidate.strip().rstrip(",").rstrip("]")
            if not candidate.startswith("{"):
                candidate = "{" + candidate
            if not candidate.endswith("}"):
                candidate = candidate + "}"
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue
        return None
    except Exception:
        return None


def calculate_paddler_sync(spm1: float, spm2: float, accel1: float, accel2: float) -> tuple[float, float]:
    """Calculate synchronization percentage (0-100%) and propulsive effort alignment."""
    spm_diff = abs(spm1 - spm2)
    accel_diff = abs(accel1 - accel2)

    # Cadence alignment score
    cadence_penalty = min(60.0, spm_diff * 12.0)
    # Power symmetry score
    accel_penalty = min(40.0, accel_diff * 20.0)

    sync_pct = max(10.0, round(100.0 - cadence_penalty - accel_penalty, 1))
    return sync_pct, round(spm_diff, 1)


def detect_paddling_side(roll_deg: float, prev_side: str) -> tuple[str, bool]:
    """Detect whether paddler is driving on STARBOARD (RIGHT) or PORT (LEFT) side based on IMU roll trim."""
    new_side = prev_side
    if roll_deg > 3.5:
        new_side = "STARBOARD"
    elif roll_deg < -3.5:
        new_side = "PORT"
    
    switch_event = (prev_side != "UNKNOWN" and new_side != prev_side)
    return new_side, switch_event


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url1", default="http://192.168.11.240/", help="HTTP endpoint for Paddler 1 hardware")
    parser.add_argument("--url2", default="http://192.168.11.219/", help="HTTP endpoint for Paddler 2 hardware")
    parser.add_argument("--port", default="/dev/ttyUSB1", help="Serial port for paddle sensor hub")
    parser.add_argument("--output", default="data/paddle-telemetry.jsonl")
    parser.add_argument("--simulate", action="store_true", help="Generate simulated paddle events if hardware is disconnected")
    parser.add_argument("--seconds", type=int, default=0, help="0 runs continuously")
    args = parser.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    print(f"Dual Paddle Telemetry Service: Starting input loop\n • Paddler 1: {args.url1}\n • Paddler 2: {args.url2}")
    started = time.monotonic()

    # Track stroke history & state for cadence calculation
    history_1 = []
    history_2 = []
    last_stroke_1 = 0.0
    last_stroke_2 = 0.0
    in_stroke_1 = False
    in_stroke_2 = False

    paddler_1_side = "STARBOARD"
    paddler_2_side = "PORT"

    with output.open("a", encoding="utf-8") as log:
        while args.seconds == 0 or (time.monotonic() - started) < args.seconds:
            if args.simulate:
                time.sleep(1.0)
                now_t = time.time()
                now_ms = int(now_t * 1000)

                # Simulate dynamic crew sync variations
                cycle_phase = (now_t * 0.25) % (math.pi * 2)
                cadence_gap = math.sin(cycle_phase) * 3.2

                spm1 = round(32.0 + (math.cos(now_t * 0.4) * 2.0), 1)
                spm2 = round(spm1 + cadence_gap, 1)
                accel1 = round(1.6 + (math.sin(now_t * 0.5) * 0.4), 2)
                accel2 = round(accel1 - (cadence_gap * 0.1), 2)

                # Simulate occasional side switches
                sim_roll1 = 4.5 if int(now_t / 12) % 2 == 0 else -4.5
                sim_roll2 = -4.2 if int(now_t / 12) % 2 == 0 else 4.2

                paddler_1_side, side_switch_1 = detect_paddling_side(sim_roll1, paddler_1_side)
                paddler_2_side, side_switch_2 = detect_paddling_side(sim_roll2, paddler_2_side)

                sync_pct, spm_delta = calculate_paddler_sync(spm1, spm2, accel1, accel2)
                avg_spm = round((spm1 + spm2) / 2.0, 1)

                record = {
                    "timestamp_unix_ms": now_ms,
                    "event": "dual_paddle_telemetry",
                    "stroke_rate_spm": avg_spm,
                    "peak_accel_g": accel1,
                    "sync_percentage": sync_pct,
                    "spm_delta": spm_delta,
                    "side_switch_active": (side_switch_1 or side_switch_2),
                    "paddler_1": {
                        "paddle_id": 1,
                        "device_name": "PADDLER-1",
                        "ip": "192.168.11.240",
                        "spm": spm1,
                        "accel_g": accel1,
                        "roll_deg": sim_roll1,
                        "pitch_deg": 0.5,
                        "side": paddler_1_side,
                        "side_switch_event": side_switch_1,
                        "temp_c": 30.5,
                        "status": "simulated"
                    },
                    "paddler_2": {
                        "paddle_id": 2,
                        "device_name": "PADDLER-2",
                        "ip": "192.168.11.219",
                        "spm": spm2,
                        "accel_g": accel2,
                        "roll_deg": sim_roll2,
                        "pitch_deg": -0.2,
                        "side": paddler_2_side,
                        "side_switch_event": side_switch_2,
                        "temp_c": 30.2,
                        "status": "simulated"
                    },
                }
                log.write(json.dumps(record) + "\n")
                log.flush()
                print(
                    f"[PADDLE SIM] Sync: {sync_pct}% | Avg SPM: {avg_spm} | "
                    f"P1: {spm1} SPM [{paddler_1_side}] | P2: {spm2} SPM [{paddler_2_side}]"
                )
            else:
                now_t = time.time()
                data1 = fetch_http_paddle(args.url1)
                data2 = fetch_http_paddle(args.url2)

                # Process Paddler 1 (Physical Hardware at http://192.168.11.219/)
                if data1:
                    accel1 = data1.get("accel_magnitude_g", 1.0)
                    gyro1 = data1.get("gyro_dps", {})
                    orient1 = data1.get("orientation_deg", {})

                    if accel1 > 1.25 or abs(gyro1.get("x", 0)) > 45:
                        if not in_stroke_1 and (now_t - last_stroke_1) > 0.8:
                            spm = round(60.0 / max(0.5, now_t - last_stroke_1), 1)
                            last_stroke_1 = now_t
                            history_1.append(spm)
                            if len(history_1) > 5:
                                history_1.pop(0)
                            in_stroke_1 = True
                    else:
                        in_stroke_1 = False
                    spm1 = round(sum(history_1) / max(1, len(history_1)), 1) if history_1 else 30.0
                    roll1 = round(orient1.get("roll", 0.0), 2)
                    pitch1 = round(orient1.get("pitch", 0.0), 2)
                    temp1 = round(data1.get("temp_c", 0.0), 1)
                else:
                    spm1, accel1, roll1, pitch1, temp1 = 30.0, 1.05, 4.5, 0.0, 28.0
                    print("  [P1] Paddler 1 sensor offline (192.168.11.240)")

                # Detect Paddling Side for Paddler 1
                paddler_1_side, side_switch_1 = detect_paddling_side(roll1, paddler_1_side)

                # Process Paddler 2 (Physical Hardware at url2 or mirrored simulation)
                if data2:
                    accel2 = data2.get("accel_magnitude_g", 1.0)
                    gyro2 = data2.get("gyro_dps", {})
                    orient2 = data2.get("orientation_deg", {})

                    if accel2 > 1.25 or abs(gyro2.get("x", 0)) > 45:
                        if not in_stroke_2 and (now_t - last_stroke_2) > 0.8:
                            spm = round(60.0 / max(0.5, now_t - last_stroke_2), 1)
                            last_stroke_2 = now_t
                            history_2.append(spm)
                            if len(history_2) > 5:
                                history_2.pop(0)
                            in_stroke_2 = True
                    else:
                        in_stroke_2 = False
                    spm2 = round(sum(history_2) / max(1, len(history_2)), 1) if history_2 else 30.0
                    roll2 = round(orient2.get("roll", 0.0), 2)
                    pitch2 = round(orient2.get("pitch", 0.0), 2)
                    temp2 = round(data2.get("temp_c", 0.0), 1)
                else:
                    # When Paddler 2 hardware is offline, mirror Paddler 1 with natural variation
                    spm2 = round(spm1 + (math.sin(now_t * 0.4) * 1.8), 1)
                    accel2 = round(accel1 + (math.cos(now_t * 0.5) * 0.08), 2)
                    roll2 = round(roll1 * -0.9, 2)
                    pitch2 = pitch1
                    temp2 = temp1

                # Detect Paddling Side for Paddler 2
                paddler_2_side, side_switch_2 = detect_paddling_side(roll2, paddler_2_side)

                sync_pct, spm_delta = calculate_paddler_sync(spm1, spm2, accel1, accel2)
                avg_spm = round((spm1 + spm2) / 2.0, 1)

                now_ms = int(now_t * 1000)
                record = {
                    "timestamp_unix_ms": now_ms,
                    "event": "dual_paddle_telemetry",
                    "stroke_rate_spm": avg_spm,
                    "peak_accel_g": round(accel1, 3),
                    "sync_percentage": sync_pct,
                    "spm_delta": spm_delta,
                    "side_switch_active": (side_switch_1 or side_switch_2),
                    "paddler_1": {
                        "paddle_id": 1,
                        "device_name": data1.get("device_name", "PADDLER-1") if data1 else "PADDLER-1",
                        "ip": data1.get("ip", "192.168.11.240") if data1 else "192.168.11.240",
                        "spm": spm1,
                        "accel_g": round(accel1, 3),
                        "roll_deg": roll1,
                        "pitch_deg": pitch1,
                        "side": paddler_1_side,
                        "side_switch_event": side_switch_1,
                        "temp_c": temp1,
                        "status": "connected" if data1 else "simulated",
                    },
                    "paddler_2": {
                        "paddle_id": 2,
                        "device_name": data2.get("device_name", "PADDLER-2") if data2 else "PADDLER-2",
                        "ip": data2.get("ip", "192.168.11.219") if data2 else "192.168.11.219",
                        "spm": spm2,
                        "accel_g": round(accel2, 3),
                        "roll_deg": roll2,
                        "pitch_deg": pitch2,
                        "side": paddler_2_side,
                        "side_switch_event": side_switch_2,
                        "temp_c": temp2,
                        "status": "connected" if data2 else "simulated",
                    }
                }
                log.write(json.dumps(record) + "\n")
                log.flush()
                print(
                    f"[DUAL PADDLE] Sync: {sync_pct}% | Avg SPM: {avg_spm} | "
                    f"P1 (.240): {spm1} SPM ({accel1:.2f}g) [{paddler_1_side}] | "
                    f"P2 (.219): {spm2} SPM ({accel2:.2f}g) [{paddler_2_side}]"
                )
                time.sleep(0.8)


if __name__ == "__main__":
    main()
