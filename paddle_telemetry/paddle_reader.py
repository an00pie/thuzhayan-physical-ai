#!/usr/bin/env python3
"""Paddle telemetry service: continuously reads dual physical paddler sensors and computes sync & efficiency.

Paddler 1: http://192.168.11.240/  (PADDLER-1)
Paddler 2: http://192.168.11.219/  (PADDLER-2)

Features:
- Robust Peak & Recovery stroke state-machine (prevents lockup during continuous motion)
- Fast 300ms sampling loop for responsive SPM calculation
- Dynamic zero-bias gyro calibration
- Auto-idle decay to 0.0 SPM after 3.5s without stroke
"""

import argparse
import json
import math
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path


def fetch_http_paddle(url: str, timeout: float = 1.5) -> dict | None:
    """Fetch the latest IMU reading from a paddle sensor endpoint."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ThuzhayanPaddleReader/1.0"})
        resp = urllib.request.urlopen(req, timeout=timeout)
        try:
            chunk = resp.read(4096).decode("utf-8", errors="replace").strip()
        finally:
            resp.close()

        chunk = chunk.lstrip("[")
        parts = chunk.split("},{")
        if not parts:
            return None

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
    if spm1 < 4.0 and spm2 < 4.0:
        return 100.0, 0.0

    spm_diff = abs(spm1 - spm2)
    accel_diff = abs(accel1 - accel2)

    cadence_penalty = min(60.0, spm_diff * 12.0)
    accel_penalty = min(40.0, accel_diff * 18.0)

    sync_pct = max(10.0, round(100.0 - cadence_penalty - accel_penalty, 1))
    return sync_pct, round(spm_diff, 1)


def detect_paddling_side(roll_deg: float, prev_side: str) -> tuple[str, bool]:
    """Detect whether paddler is driving on STARBOARD (RIGHT) or PORT (LEFT) side using hysteresis."""
    new_side = prev_side
    if roll_deg > 5.0:
        new_side = "STARBOARD"
    elif roll_deg < -5.0:
        new_side = "PORT"

    switch_event = (prev_side not in ("UNKNOWN", "") and new_side != prev_side)
    return new_side, switch_event


class PaddlerTracker:
    def __init__(self, paddle_id: int, default_ip: str):
        self.paddle_id = paddle_id
        self.default_ip = default_ip
        self.gyro_bias_x = 0.0
        self.bias_samples = 0
        self.history = []
        self.last_stroke_time = 0.0
        self.drive_start_time = 0.0
        self.in_stroke = False
        self.current_side = "STARBOARD" if paddle_id == 1 else "PORT"

    def process_sample(self, data: dict | None, now_t: float) -> dict:
        if not data:
            time_since_stroke = now_t - self.last_stroke_time if self.last_stroke_time > 0 else 999.0
            spm = 0.0 if time_since_stroke > 3.5 else (round(sum(self.history) / len(self.history), 1) if self.history else 0.0)
            return {
                "spm": spm,
                "accel_g": 1.0,
                "roll_deg": 0.0,
                "pitch_deg": 0.0,
                "side": self.current_side,
                "side_switch_event": False,
                "temp_c": 28.0,
                "status": "offline"
            }

        accel_mag = data.get("accel_magnitude_g", 1.0)
        gyro = data.get("gyro_dps", {})
        orient = data.get("orientation_deg", {})

        gyro_x_raw = gyro.get("x", 0.0)
        gyro_y_raw = gyro.get("y", 0.0)
        gyro_z_raw = gyro.get("z", 0.0)

        # 1. Zero-bias Gyro Calibration (when resting still)
        if abs(accel_mag - 1.0) < 0.08 and abs(gyro_y_raw) < 10.0 and abs(gyro_z_raw) < 10.0:
            if self.bias_samples < 30:
                self.gyro_bias_x = (self.gyro_bias_x * self.bias_samples + gyro_x_raw) / (self.bias_samples + 1)
                self.bias_samples += 1
            else:
                self.gyro_bias_x = 0.95 * self.gyro_bias_x + 0.05 * gyro_x_raw

        dynamic_gyro_x = abs(gyro_x_raw - self.gyro_bias_x)
        dynamic_gyro_y = abs(gyro_y_raw)
        dynamic_gyro_z = abs(gyro_z_raw)
        dynamic_accel = abs(accel_mag - 1.0)

        # Unified Motion Index (combining acceleration spike and rotation rate)
        motion_score = max(
            dynamic_accel * 2.5,
            dynamic_gyro_x / 25.0,
            dynamic_gyro_y / 25.0,
            dynamic_gyro_z / 25.0
        )

        # 2. Peak & Recovery Stroke State Machine
        if motion_score > 0.22:
            if not self.in_stroke and (now_t - self.last_stroke_time) > 0.6:
                if self.last_stroke_time > 0:
                    dt = now_t - self.last_stroke_time
                    if 0.5 <= dt <= 4.5:
                        inst_spm = round(60.0 / dt, 1)
                        self.history.append(inst_spm)
                        if len(self.history) > 4:
                            self.history.pop(0)

                self.last_stroke_time = now_t
                self.drive_start_time = now_t
                self.in_stroke = True
        
        # Reset stroke lock after motion drops OR max drive timeout (0.7s) to prevent lockup
        if self.in_stroke:
            if motion_score < 0.15 or (now_t - self.drive_start_time) > 0.7:
                self.in_stroke = False

        # 3. Idle timeout (reset to 0.0 SPM if stationary > 3.5 seconds)
        time_since_stroke = now_t - self.last_stroke_time if self.last_stroke_time > 0 else 999.0
        if time_since_stroke > 3.5:
            spm = 0.0
            self.history.clear()
        else:
            spm = round(sum(self.history) / len(self.history), 1) if self.history else 0.0

        roll = round(orient.get("roll", 0.0), 2)
        pitch = round(orient.get("pitch", 0.0), 2)
        temp = round(data.get("temp_c", 0.0), 1)

        self.current_side, side_switch = detect_paddling_side(roll, self.current_side)

        return {
            "spm": spm,
            "accel_g": round(accel_mag, 3),
            "roll_deg": roll,
            "pitch_deg": pitch,
            "side": self.current_side,
            "side_switch_event": side_switch,
            "temp_c": temp,
            "status": "connected"
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url1", default="http://192.168.11.240/", help="HTTP endpoint for Paddler 1 hardware")
    parser.add_argument("--url2", default="http://192.168.11.219/", help="HTTP endpoint for Paddler 2 hardware")
    parser.add_argument("--output", default="data/paddle-telemetry.jsonl")
    parser.add_argument("--simulate", action="store_true", help="Generate simulated paddle events if hardware is disconnected")
    parser.add_argument("--seconds", type=int, default=0, help="0 runs continuously")
    args = parser.parse_args()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    print(f"Dual Paddle Telemetry Service: Starting input loop\n • Paddler 1: {args.url1}\n • Paddler 2: {args.url2}")
    started = time.monotonic()

    tracker1 = PaddlerTracker(1, "192.168.11.240")
    tracker2 = PaddlerTracker(2, "192.168.11.219")

    with output.open("a", encoding="utf-8") as log:
        while args.seconds == 0 or (time.monotonic() - started) < args.seconds:
            now_t = time.time()
            now_ms = int(now_t * 1000)

            if args.simulate:
                time.sleep(0.4)
                cycle_phase = (now_t * 0.25) % (math.pi * 2)
                cadence_gap = math.sin(cycle_phase) * 3.2
                spm1 = round(32.0 + (math.cos(now_t * 0.4) * 2.0), 1)
                spm2 = round(spm1 + cadence_gap, 1)
                accel1 = round(1.6 + (math.sin(now_t * 0.5) * 0.4), 2)
                accel2 = round(accel1 - (cadence_gap * 0.1), 2)

                sim_roll1 = 7.5 if int(now_t / 12) % 2 == 0 else -7.5
                sim_roll2 = -7.2 if int(now_t / 12) % 2 == 0 else 7.2

                side1, switch1 = detect_paddling_side(sim_roll1, tracker1.current_side)
                side2, switch2 = detect_paddling_side(sim_roll2, tracker2.current_side)

                sync_pct, spm_delta = calculate_paddler_sync(spm1, spm2, accel1, accel2)
                avg_spm = round((spm1 + spm2) / 2.0, 1)

                p1_res = {"spm": spm1, "accel_g": accel1, "roll_deg": sim_roll1, "pitch_deg": 0.5, "side": side1, "side_switch_event": switch1, "temp_c": 30.5, "status": "simulated"}
                p2_res = {"spm": spm2, "accel_g": accel2, "roll_deg": sim_roll2, "pitch_deg": -0.2, "side": side2, "side_switch_event": switch2, "temp_c": 30.2, "status": "simulated"}
            else:
                data1 = fetch_http_paddle(args.url1)
                data2 = fetch_http_paddle(args.url2)

                p1_res = tracker1.process_sample(data1, now_t)
                p2_res = tracker2.process_sample(data2, now_t)

                spm1 = p1_res["spm"]
                spm2 = p2_res["spm"]
                accel1 = p1_res["accel_g"]
                accel2 = p2_res["accel_g"]

                sync_pct, spm_delta = calculate_paddler_sync(spm1, spm2, accel1, accel2)
                avg_spm = round((spm1 + spm2) / 2.0, 1) if (spm1 > 0 or spm2 > 0) else 0.0

            record = {
                "timestamp_unix_ms": now_ms,
                "event": "dual_paddle_telemetry",
                "stroke_rate_spm": avg_spm,
                "peak_accel_g": accel1,
                "sync_percentage": sync_pct,
                "spm_delta": spm_delta,
                "side_switch_active": (p1_res["side_switch_event"] or p2_res["side_switch_event"]),
                "paddler_1": {
                    "paddle_id": 1,
                    "device_name": "PADDLER-1",
                    "ip": "192.168.11.240",
                    **p1_res
                },
                "paddler_2": {
                    "paddle_id": 2,
                    "device_name": "PADDLER-2",
                    "ip": "192.168.11.219",
                    **p2_res
                }
            }

            log.write(json.dumps(record) + "\n")
            log.flush()

            status_str = "IDLE" if avg_spm == 0.0 else f"{avg_spm} SPM"
            print(
                f"[DUAL PADDLE] Status: {status_str} | Sync: {sync_pct}% | "
                f"P1 (.240): {spm1} SPM ({accel1}g) [{p1_res['side']}] | "
                f"P2 (.219): {spm2} SPM ({accel2}g) [{p2_res['side']}]"
            )
            time.sleep(0.35)


if __name__ == "__main__":
    main()
