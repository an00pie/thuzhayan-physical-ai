#!/usr/bin/env python3
"""Local Gemma Edge AI Engine: Analyzes boat & paddle sensor data locally on RPi 5."""

import json
import time
import urllib.request
import urllib.error
from pathlib import Path
from threading import Lock


_advice_cache = {
    "timestamp": 0,
    "data": None
}
_cache_lock = Lock()


def load_recent_telemetry(boat_log: Path, paddle_log: Path):
    boat_frame = {}
    if boat_log.exists():
        with boat_log.open(encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]
            if lines:
                try:
                    boat_frame = json.loads(lines[-1])
                except Exception:
                    pass

    paddle_frame = {}
    if paddle_log.exists():
        with paddle_log.open(encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]
            if lines:
                try:
                    paddle_frame = json.loads(lines[-1])
                except Exception:
                    pass

    return boat_frame, paddle_frame


def discover_gemma_model(endpoint: str = "http://localhost:11434/api/tags") -> str:
    """Auto-detect installed local Gemma model in Ollama, prioritizing 1B models (gemma:1b, gemma3:1b, gemma2:1b)."""
    import os
    env_model = os.environ.get("GEMMA_MODEL")
    if env_model:
        return env_model

    try:
        req = urllib.request.Request(endpoint, method="GET")
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            models = [m.get("name", "") for m in data.get("models", [])]
            
            # 1. First priority: exact 1b models (e.g. gemma:1b, gemma2:1b, gemma3:1b)
            for m in models:
                if "gemma" in m.lower() and "1b" in m.lower():
                    return m

            # 2. Second priority: 2b models
            for m in models:
                if "gemma" in m.lower() and "2b" in m.lower():
                    return m

            # 3. Third priority: any gemma model
            for m in models:
                if "gemma" in m.lower():
                    return m
            if models:
                return models[0]
    except Exception:
        pass
    return "gemma:1b"


def query_ollama_gemma(prompt: str, model: str | None = None, endpoint: str = "http://localhost:11434/api/generate", timeout: float = 6.0) -> tuple[str | None, str]:
    """Attempt to query local Ollama Gemma instance running on Raspberry Pi 5 / local machine."""
    if not model:
        model = discover_gemma_model()

    try:
        payload = json.dumps({
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "num_predict": 85,
                "temperature": 0.3,
            }
        }).encode("utf-8")
        req = urllib.request.Request(endpoint, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            res_text = data.get("response", "").strip()
            if res_text:
                return res_text, model
    except Exception:
        pass
    return None, model or "gemma:1b"


def format_split_500m(speed_kmh: float) -> str:
    """Convert boat speed in km/h to standard rowing split 500m pace (MM:SS)."""
    if speed_kmh <= 0.1:
        return "— / 500m"
    speed_mps = speed_kmh / 3.6
    split_seconds = 500.0 / speed_mps
    mins = int(split_seconds // 60)
    secs = int(split_seconds % 60)
    return f"{mins}:{secs:02d} / 500m"


def generate_local_gemma_heuristics(boat: dict, paddle: dict) -> str:
    """Local edge fallback generator mirroring Gemma 2B/3B hydrodynamic reasoning rules."""
    speed = boat.get("speed_kmh", 0.0)
    yaw_stab = boat.get("yaw_stability_10s_dps", 0.0)
    drift = boat.get("drift_deg")
    roll = boat.get("roll_deg", 0.0)

    spm = paddle.get("stroke_rate_spm", 0.0)
    sync_pct = paddle.get("sync_percentage")
    p1 = paddle.get("paddler_1", {})
    p2 = paddle.get("paddler_2", {})
    spm1 = p1.get("spm", spm)
    spm2 = p2.get("spm", spm)
    alert = boat.get("gpio_alert_active", False)

    tips = []

    # 1. Dual Paddler Synchronization Evaluation
    if sync_pct is not None:
        if sync_pct < 80.0:
            tips.append(
                f"👥 PADDLER SYNCHRONIZATION WARNING (Sync Score: {sync_pct:.1f}%): "
                f"Cadence mismatch detected (P1: {spm1} SPM vs P2: {spm2} SPM). "
                f"Rationale: Out-of-phase blade entries increase hull drag. Recommendation: Follow Paddler 1's stroke rate."
            )
        else:
            tips.append(
                f"✅ STRONG CREW SYNCHRONIZATION ({sync_pct:.1f}% Sync): "
                f"Paddlers are driving in phase (Avg: {spm} SPM). Wasted kinetic drag is minimized."
            )

    # 2. Distance Per Stroke (DPS) & Efficiency
    if spm > 0 and speed > 0:
        speed_mps = speed / 3.6
        dps_m = (speed_mps * 60.0) / max(1.0, spm)
        split_str = format_split_500m(speed)
        if dps_m < 1.2:
            tips.append(
                f"⚡ LOW EFFICIENCY (DPS: {dps_m:.2f} m/stroke | Split: {split_str}): "
                f"High stroke rate ({spm} SPM) yielding low forward gain. Rationale: Blade slipping at catch entry. Focus on anchoring blade fully."
            )
        else:
            tips.append(
                f"💪 PROPULSIVE DRIVE (DPS: {dps_m:.2f} m/stroke | Split: {split_str}): "
                f"Effective kinetic power transfer per stroke."
            )

    # 3. Physics & Hull Drift evaluation
    if alert or yaw_stab > 4.5:
        tips.append(
            "⚠️ HIGH YAW OSCILLATION: Hull stability compromised. "
            "Rationale: Unbalanced stroke force or rudder overcorrection. Equalize port/starboard pressure."
        )

    if roll > 3.0:
        tips.append(f"⚖️ HULL LEAN (Roll: {roll}°): Boat leaning right. Rationale: Right blade catch deeper than left. Adjust handle height.")
    elif roll < -3.0:
        tips.append(f"⚖️ HULL LEAN (Roll: {roll}°): Boat leaning left. Rationale: Left blade catch deeper than right. Adjust handle height.")

    if drift is not None and abs(drift) > 7.0:
        tips.append(f"🌊 HEADING DRIFT ({drift}°): Cross-wind/current deviation detected. Compensate course line by {-round(drift, 1)}°.")

    if not tips:
        tips.append("📊 NORMAL HYDRODYNAMICS: Telemetry nominal. Maintain current rhythm and trim.")

    header = "🤖 LOCAL GEMMA EDGE AI ANALYSIS (RPi 5 Dual-Paddler Loop)\n--------------------------------------------------\n"
    return header + "\n\n".join(tips)


def get_gemma_coaching_advice(boat_log_path: str = "data/boat-telemetry.jsonl", paddle_log_path: str = "data/paddle-telemetry.jsonl", cache_ttl: float = 4.0) -> dict:
    now = time.time()
    with _cache_lock:
        if _advice_cache["data"] is not None and (now - _advice_cache["timestamp"]) < cache_ttl:
            return _advice_cache["data"]

    boat, paddle = load_recent_telemetry(Path(boat_log_path), Path(paddle_log_path))
    if not boat:
        res = {"status": "waiting", "advice": "Waiting for active telemetry hardware data..."}
        with _cache_lock:
            _advice_cache["timestamp"] = now
            _advice_cache["data"] = res
        return res

    speed = boat.get("speed_kmh", 0.0)
    split_500m = format_split_500m(speed)
    sync_pct = paddle.get("sync_percentage", 100.0)

    detected_model = discover_gemma_model()
    prompt = (
        f"You are Gemma Edge AI, expert hydrodynamic boat coach running locally on Raspberry Pi 5.\n"
        f"Analyze these physical telemetry readings and give 2 bullet points of tactical advice:\n"
        f"Speed: {speed} km/h (Split 500m: {split_500m}), Yaw Stability: {boat.get('yaw_stability_10s_dps')} deg/s, "
        f"Drift: {boat.get('drift_deg')} deg, Roll: {boat.get('roll_deg')} deg, Pitch: {boat.get('pitch_deg')} deg.\n"
        f"Dual-Paddler Synchronization: {sync_pct}%, Avg SPM: {paddle.get('stroke_rate_spm', 'N/A')}, "
        f"P1 SPM: {paddle.get('paddler_1', {}).get('spm')}, P2 SPM: {paddle.get('paddler_2', {}).get('spm')}."
    )

    llm_response, model_used = query_ollama_gemma(prompt, model=detected_model)
    if llm_response:
        advice_text = f"🤖 LOCAL GEMMA MODEL ({model_used.upper()} via Ollama RPi 5)\n--------------------------------------------------\n" + llm_response
        engine = f"ollama_{model_used}"
    else:
        advice_text = generate_local_gemma_heuristics(boat, paddle)
        engine = "gemma_edge_heuristics_engine"

    res = {
        "status": "active",
        "engine": engine,
        "advice": advice_text,
        "gemma_model": model_used if llm_response else f"{detected_model} (fallback active)",
        "boat_summary": {
            "speed_kmh": speed,
            "split_500m": split_500m,
            "yaw_stability": boat.get("yaw_stability_10s_dps"),
            "drift_deg": boat.get("drift_deg"),
            "gpio_alert": boat.get("gpio_alert_active", False),
        },
        "paddle_summary": {
            "sync_percentage": sync_pct,
            "spm": paddle.get("stroke_rate_spm"),
            "p1_spm": paddle.get("paddler_1", {}).get("spm"),
            "p2_spm": paddle.get("paddler_2", {}).get("spm"),
            "accel": paddle.get("peak_accel_g"),
        }
    }

    with _cache_lock:
        _advice_cache["timestamp"] = now
        _advice_cache["data"] = res
    return res


if __name__ == "__main__":
    res = get_gemma_coaching_advice(cache_ttl=0.0)
    print(res["advice"])

