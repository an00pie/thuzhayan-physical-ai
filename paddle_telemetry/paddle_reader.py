#!/usr/bin/env python3
"""Paddle telemetry service: continuously reads dual physical paddler sensors (http://192.168.11.219/ and Paddler-2) and computes sync & efficiency."""

import argparse
import json
import math
import random
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


def fetch_http_paddle(url: str, timeout: float = 1.8) -> dict | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ThuzhayanPaddleReader/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8").strip()
            return json.loads(raw)
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url1", default="http://192.168.11.219/", help="HTTP endpoint for Paddler 1 hardware")
    parser.add_argument("--url2", default="http://192.168.11.220/", help="HTTP endpoint for Paddler 2 hardware")
    parser.add_argument("--port", default="/dev/ttyUSB1", help="Serial port for paddle sensor hub")
    parser.add_argument("--output", default="data/paddle-telemetry.jsonl")
    parser.add_argument("--simulate", action="store_true", help="Generate simulated paddle events if hardware is disconnected")
    parser.add_argument("--seconds", type=int, default=0, help="0 runs continuously")
    args = parser.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    print(f"Dual Paddle Telemetry Service: Starting input loop\n • Paddler 1: {args.url1}\n • Paddler 2: {args.url2}")
    started = time.monotonic()

    # Paddler 1 tracking
    last_stroke_1 = time.time()
    history_1 = []
    in_stroke_1 = False

    # Paddler 2 tracking
    last_stroke_2 = time.time()
    history_2 = []
    in_stroke_2 = False

    with output.open("a", encoding="utf-8") as log:
        while args.seconds == 0 or (time.monotonic() - started) < args.seconds:
            if args.simulate:
                time.sleep(1.5)
                now_ms = int(time.time() * 1000)
                spm1 = round(random.uniform(31.5, 34.0), 1)
                spm2 = round(spm1 + random.uniform(-2.5, 2.5), 1)
                accel1 = round(random.uniform(1.4, 2.2), 2)
                accel2 = round(accel1 + random.uniform(-0.3, 0.3), 2)

                sync_pct, spm_delta = calculate_paddler_sync(spm1, spm2, accel1, accel2)
                avg_spm = round((spm1 + spm2) / 2.0, 1)

                record = {
                    "timestamp_unix_ms": now_ms,
                    "event": "dual_paddle_telemetry",
                    "stroke_rate_spm": avg_spm,
                    "peak_accel_g": accel1,
                    "paddler_1": {"paddle_id": 1, "device_name": "PADDLER-1", "spm": spm1, "accel_g": accel1, "roll_deg": round(random.uniform(-4, 4), 1)},
                    "paddler_2": {"paddle_id": 2, "device_name": "PADDLER-2", "spm": spm2, "accel_g": accel2, "roll_deg": round(random.uniform(-4, 4), 1)},
                    "sync_percentage": sync_pct,
                    "spm_delta": spm_delta,
                }
                log.write(json.dumps(record) + "\n")
                log.flush()
                print(f"[DUAL PADDLE SIM] Sync: {sync_pct}% | Avg SPM: {avg_spm} | P1: {spm1} SPM, P2: {spm2} SPM")
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
                    spm1, accel1, roll1, pitch1, temp1 = 30.0, 1.05, 0.0, 0.0, 28.0

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
                    # When Paddler 2 hardware is offline, mirror Paddler 1 with minor natural cadence variation
                    spm2 = round(spm1 + (math.sin(now_t * 0.4) * 1.8), 1)
                    accel2 = round(accel1 + (math.cos(now_t * 0.5) * 0.08), 2)
                    roll2 = round(roll1 * -0.8, 2)
                    pitch2 = pitch1
                    temp2 = temp1

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
                    "paddler_1": {
                        "paddle_id": 1,
                        "device_name": data1.get("device_name", "PADDLER-1") if data1 else "PADDLER-1",
                        "ip": data1.get("ip", "192.168.11.219") if data1 else "192.168.11.219",
                        "spm": spm1,
                        "accel_g": round(accel1, 3),
                        "roll_deg": roll1,
                        "pitch_deg": pitch1,
                        "temp_c": temp1,
                        "status": "connected" if data1 else "simulated",
                    },
                    "paddler_2": {
                        "paddle_id": 2,
                        "device_name": data2.get("device_name", "PADDLER-2") if data2 else "PADDLER-2",
                        "ip": data2.get("ip", "192.168.11.220") if data2 else "192.168.11.220",
                        "spm": spm2,
                        "accel_g": round(accel2, 3),
                        "roll_deg": roll2,
                        "pitch_deg": pitch2,
                        "temp_c": temp2,
                        "status": "connected" if data2 else "simulated",
                    }
                }
                log.write(json.dumps(record) + "\n")
                log.flush()
                print(
                    f"[DUAL PADDLE] Sync: {sync_pct}% | Avg SPM: {avg_spm} | "
                    f"P1 (192.168.11.219): {spm1} SPM ({accel1:.2f}g) | P2: {spm2} SPM ({accel2:.2f}g)"
                )
                time.sleep(0.8)


if __name__ == "__main__":
    main()


