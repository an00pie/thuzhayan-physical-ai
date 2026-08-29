#!/usr/bin/env python3
"""Create a human-readable overall report from one boat telemetry run."""

import argparse
import json
import statistics
from pathlib import Path


def load_records(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as log:
        return [json.loads(line) for line in log if line.strip()]


def numbers(records: list[dict], field: str) -> list[float]:
    return [record[field] for record in records if isinstance(record.get(field), (int, float))]


def build_report(records: list[dict]) -> str:
    if not records:
        return "No telemetry records found."

    speeds = numbers(records, "speed_kmh")
    yaw_stability = numbers(records, "yaw_stability_10s_dps")
    distances = numbers(records, "distance_m")
    healthy = sum(bool(record.get("gps_healthy")) for record in records)
    duration_s = max(0, (records[-1]["timestamp_unix_ms"] - records[0]["timestamp_unix_ms"]) / 1000)
    final = records[-1]
    moving = max(speeds, default=0) >= 0.72

    lines = [
        "OVERALL BOAT TELEMETRY REPORT",
        "=" * 31,
        f"Samples recorded: {len(records)}",
        f"Run duration:      {duration_s:.1f} seconds",
        f"GPS availability:  {healthy / len(records) * 100:.0f}% of samples healthy",
        f"Boat state:        {'movement detected' if moving else 'stationary simulation'}",
        f"Average speed:     {statistics.mean(speeds):.2f} km/h" if speeds else "Average speed:     —",
        f"Peak speed:        {max(speeds):.2f} km/h" if speeds else "Peak speed:        —",
        f"Distance:          {max(distances, default=0):.2f} m",
        f"Avg yaw stability: {statistics.mean(yaw_stability):.2f} °/s" if yaw_stability else "Avg yaw stability: —",
        f"Peak yaw motion:   {max(abs(value) for value in numbers(records, 'yaw_rate_dps')):.2f} °/s"
        if numbers(records, "yaw_rate_dps") else "Peak yaw motion:   —",
        f"Final heading:     {final.get('heading_deg', '—')}°",
        f"Final GPS:         {final.get('gps_satellites', '—')} satellites, fix {final.get('gps_fix', '—')}",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("log", nargs="?", default="data/boat-telemetry.jsonl")
    args = parser.parse_args()
    print(build_report(load_records(Path(args.log))))


if __name__ == "__main__":
    main()
