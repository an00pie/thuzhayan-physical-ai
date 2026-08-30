"""Fetch accelerometer telemetry from an HTTP endpoint and plot it live."""

from __future__ import annotations

import ast
import json
import math
import os
import random
import sys
import time
from collections import deque
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# Some headless or container environments have a read-only Matplotlib config directory.
os.environ.setdefault("MPLCONFIGDIR", f"/tmp/matplotlib-{os.getuid()}")

from dotenv import load_dotenv

load_dotenv()

import matplotlib

# QtAgg opens the interactive graph in a native desktop window.
matplotlib.use(os.getenv("ACCELEROMETER_MATPLOTLIB_BACKEND", "QtAgg"))

import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from matplotlib.widgets import Slider


ENDPOINT_ENV_VAR = "ACCELEROMETER_ENDPOINT_URL"
POLL_INTERVAL_ENV_VAR = "ACCELEROMETER_POLL_INTERVAL_SECONDS"
MAX_POINTS_ENV_VAR = "ACCELEROMETER_MAX_POINTS"
MOCK_DATA_ENV_VAR = "ACCELEROMETER_USE_MOCK_DATA"
CLOCK_SYNC_URLS_ENV_VAR = "CLOCK_SYNC_ENDPOINT_URLS"
CLOCK_SYNC_INTERVAL_ENV_VAR = "CLOCK_SYNC_INTERVAL_SECONDS"
MOCK_CLOCK_DRIFT_ENV_VAR = "MOCK_CLOCK_DRIFT_PPM"
MOCK_PADDLE_COUNT_ENV_VAR = "MOCK_PADDLE_COUNT"
FC_ENDPOINT_ENV_VAR = "FC_ENDPOINT_URL"
TROUGH_MIN_DISTANCE_SECONDS_ENV_VAR = "TROUGH_MIN_DISTANCE_SECONDS"


def read_bool(name: str, default: bool = False) -> bool:
    raw_value = os.getenv(name, str(default)).strip().lower()
    if raw_value in {"1", "true", "yes", "on"}:
        return True
    if raw_value in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false, got {raw_value!r}")


def read_positive_float(name: str, default: float) -> float:
    raw_value = os.getenv(name, str(default))
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number, got {raw_value!r}") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def read_positive_int(name: str, default: int) -> int:
    raw_value = os.getenv(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw_value!r}") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def fetch_samples(url: str, timeout: float) -> list[dict[str, Any]]:
    """Fetch one event or a queue batch of telemetry events."""
    request = Request(url, headers={"Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        payload = json.load(response)

    if isinstance(payload, dict):
        return [payload]
    if isinstance(payload, list) and all(isinstance(item, dict) for item in payload):
        return payload
    raise ValueError("Endpoint must return a JSON object or a list of JSON objects")


def fetch_fc_messages(url: str, timeout: float) -> list[dict[str, Any]]:
    """Fetch MAVLink messages as JSON or in the line-oriented fc.json format."""
    request = Request(url, headers={"Accept": "application/json, text/plain"})
    with urlopen(request, timeout=timeout) as response:
        text = response.read().decode("utf-8")

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        messages = []
        for line in text.splitlines():
            if "] " not in line:
                continue
            _label, mapping = line.split("] ", 1)
            try:
                message = ast.literal_eval(mapping)
            except (SyntaxError, ValueError):
                continue
            if isinstance(message, dict):
                messages.append(message)
        if not messages:
            raise ValueError("FC endpoint did not return recognizable MAVLink data")
        return messages

    if isinstance(payload, list) and all(isinstance(item, dict) for item in payload):
        return payload
    if isinstance(payload, dict) and "mavpackettype" in payload:
        return [payload]
    if isinstance(payload, dict) and all(isinstance(item, dict) for item in payload.values()):
        return list(payload.values())
    raise ValueError("FC endpoint must return MAVLink objects or an fc.json-style dump")


def send_clock_sync(urls: list[str], rpi_time_ms: int, timeout: float = 1.0) -> None:
    """Ask each device to align its clock; unavailable prototype endpoints are ignored."""
    body = json.dumps({"command": "synchronize_clock", "rpi_time_ms": rpi_time_ms}).encode()
    for url in urls:
        request = Request(
            url,
            data=body,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=timeout):
                pass
        except (HTTPError, URLError, TimeoutError):
            # The ESP32 clock-sync interfaces are optional while they are being built.
            pass


class MockDeviceClock:
    """A drifting ESP32 clock that can be synchronized to the simulated RPi clock."""

    def __init__(self, drift_ppm: float) -> None:
        self.drift_factor = 1.0 + drift_ppm / 1_000_000
        self.device_ms_at_sync = 0.0
        self.rpi_elapsed_at_sync = 0.0

    def time_ms(self, rpi_elapsed: float) -> int:
        since_sync = rpi_elapsed - self.rpi_elapsed_at_sync
        return int(self.device_ms_at_sync + since_sync * 1000 * self.drift_factor)

    def synchronize(self, rpi_elapsed: float) -> None:
        self.device_ms_at_sync = rpi_elapsed * 1000
        self.rpi_elapsed_at_sync = rpi_elapsed


def accelerometer_values(sample: dict[str, Any]) -> tuple[float, float, float]:
    try:
        acceleration = sample["accel_g"]
        return (
            float(acceleration["x"]),
            float(acceleration["y"]),
            float(acceleration["z"]),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(
            "Each sample must contain numeric accel_g.x, accel_g.y, and accel_g.z values"
        ) from exc


def paddler_id_from_sample(sample: dict[str, Any]) -> Any:
    """Return the server-assigned paddler identity used to group telemetry."""
    paddler_id = sample.get("paddler_id")
    if paddler_id is None:
        raise ValueError("Each accelerometer event must contain paddler_id")
    return paddler_id


def make_mock_sample(
    elapsed: float,
    device_id: int,
    device_ms: int,
    phase_offset: float = 0.0,
    scale: float = 1.0,
) -> dict[str, Any]:
    """Return a realistic-looking sample with the same shape as data.json."""
    noise = lambda: random.uniform(-0.055, 0.055)
    device_bias = ((device_id - 1) % 3) - 1
    return {
        "device_id": device_id,
        "device_name": f"MOCK-PADDLER-{device_id}",
        "paddler_id": device_id,
        "device_ms": device_ms,
        "accel_g": {
            "x": (
                scale * 0.30 * math.sin(elapsed * 2.1 + phase_offset)
                + 0.055 * device_bias
                + 0.045 * math.sin(elapsed * (3.2 + device_id * 0.15))
                + noise()
            ),
            "y": (
                scale * 0.20 * math.sin(elapsed * 1.4 + 0.8 + phase_offset)
                - 0.045 * device_bias
                + 0.035 * math.sin(elapsed * (2.5 + device_id * 0.2))
                + noise()
            ),
            "z": (
                1.0
                + scale * 0.12 * math.sin(elapsed * 2.8 + 1.5 + phase_offset)
                + 0.04 * device_bias
                + noise()
            ),
        },
    }


def fc_velocity_magnitude(message: dict[str, Any]) -> float:
    """Return the 3D GLOBAL_POSITION_INT velocity magnitude in metres/second."""
    try:
        return (
            math.sqrt(
                float(message["vx"]) ** 2
                + float(message["vy"]) ** 2
                + float(message["vz"]) ** 2
            )
            / 100
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(
            "GLOBAL_POSITION_INT must contain numeric vx, vy, and vz"
        ) from exc


def make_mock_fc_message(elapsed: float) -> dict[str, Any]:
    """Return mock GLOBAL_POSITION_INT velocity data in centimetres/second."""
    return {
        "mavpackettype": "GLOBAL_POSITION_INT",
        "time_boot_ms": int(elapsed * 1000),
        "vx": int(170 + 45 * math.sin(elapsed * 0.8) + random.uniform(-8, 8)),
        "vy": int(35 * math.sin(elapsed * 0.55 + 0.6) + random.uniform(-6, 6)),
        "vz": int(12 * math.sin(elapsed * 0.4) + random.uniform(-3, 3)),
    }


def find_trough_indices(
    times: list[float], values: list[float], min_distance_seconds: float
) -> list[int]:
    """Locate meaningful troughs using a signal-relative prominence threshold."""
    if len(values) < 7:
        return []

    signal_range = max(values) - min(values)
    min_prominence = max(0.005, signal_range * 0.06)
    candidates: list[int] = []
    radius = 2
    prominence_radius = max(3, min(15, len(values) // 6))

    for index in range(radius, len(values) - radius):
        neighbourhood = values[index - radius : index + radius + 1]
        if values[index] != min(neighbourhood):
            continue
        left = values[max(0, index - prominence_radius) : index]
        right = values[index + 1 : min(len(values), index + prominence_radius + 1)]
        prominence = min(max(left), max(right)) - values[index]
        if prominence >= min_prominence:
            candidates.append(index)

    troughs: list[int] = []
    for index in candidates:
        if not troughs or times[index] - times[troughs[-1]] >= min_distance_seconds:
            troughs.append(index)
        elif values[index] < values[troughs[-1]]:
            troughs[-1] = index
    return troughs


def main() -> int:
    try:
        use_mock_data = read_bool(MOCK_DATA_ENV_VAR)
        poll_interval = read_positive_float(POLL_INTERVAL_ENV_VAR, 0.1)
        max_points = read_positive_int(MAX_POINTS_ENV_VAR, 300)
        clock_sync_interval = read_positive_float(CLOCK_SYNC_INTERVAL_ENV_VAR, 30.0)
        mock_clock_drift_ppm = float(os.getenv(MOCK_CLOCK_DRIFT_ENV_VAR, "80"))
        mock_paddle_count = read_positive_int(MOCK_PADDLE_COUNT_ENV_VAR, 3)
        trough_min_distance = read_positive_float(
            TROUGH_MIN_DISTANCE_SECONDS_ENV_VAR, 0.6
        )
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    url = os.getenv(ENDPOINT_ENV_VAR)
    fc_url = os.getenv(FC_ENDPOINT_ENV_VAR)
    show_accelerometer = use_mock_data or bool(url)
    show_fc = use_mock_data or bool(fc_url)

    device_series: dict[Any, dict[str, deque[float]]] = {}
    device_lines: dict[Any, Any] = {}
    device_trough_lines: dict[Any, Any] = {}
    trough_annotations: list[Any] = []
    fc_times: deque[float] = deque(maxlen=max_points)
    fc_distances: deque[float] = deque(maxlen=max_points)
    total_distance = 0.0
    previous_fc_time: float | None = None
    started_at = time.monotonic()
    current_poll_interval = poll_interval
    last_clock_sync = -clock_sync_interval
    clock_sync_urls = [
        item.strip()
        for item in os.getenv(CLOCK_SYNC_URLS_ENV_VAR, "").split(",")
        if item.strip()
    ]
    mock_clocks = [
        MockDeviceClock(
            mock_clock_drift_ppm * (1 if index % 2 == 0 else -0.75) * (index + 1)
        )
        for index in range(mock_paddle_count)
    ]

    figure, (axis, fc_axis) = plt.subplots(1, 2, figsize=(15, 7))
    axis.set_visible(show_accelerometer)
    fc_axis.set_visible(show_fc)
    status = axis.text(0.01, 0.99, "Waiting for data...", va="top", transform=axis.transAxes)
    axis.set_title("Paddle acceleration and stroke periods")
    axis.set_xlabel("Synchronized device time (seconds)")
    axis.set_ylabel("Acceleration magnitude (g)")
    axis.grid(True, alpha=0.3)

    fc_status = fc_axis.text(
        0.01, 0.99, "Waiting for FC data...", va="top", transform=fc_axis.transAxes
    )
    fc_axis.set_title("Flight controller distance travelled")
    fc_axis.set_xlabel("FC time (seconds)")
    fc_axis.set_ylabel("Cumulative distance (m)")
    fc_axis.grid(True, alpha=0.3)

    fc_distance_line, = fc_axis.plot(
        [], [], color="tab:purple", linewidth=1.8, label="Distance travelled"
    )
    fc_axis.legend(loc="lower left")

    def add_device(sample: dict[str, Any]) -> Any | None:
        paddler_id = paddler_id_from_sample(sample)
        if paddler_id not in device_series:
            device_series[paddler_id] = {
                "time": deque(maxlen=max_points),
                "acceleration": deque(maxlen=max_points),
            }
            device_name = str(sample.get("device_name", f"Paddler {paddler_id}"))
            line, = axis.plot([], [], linewidth=1.0, linestyle="--", alpha=0.5,
                              label=device_name)
            device_lines[paddler_id] = line
            trough_line, = axis.plot([], [], linestyle="none", marker="v",
                                     markersize=6, color=line.get_color())
            device_trough_lines[paddler_id] = trough_line
            axis.legend(loc="lower left", ncols=2, fontsize="small")
        return paddler_id

    def update(_frame: int) -> tuple[Any, ...]:
        nonlocal last_clock_sync, previous_fc_time, total_distance, trough_annotations
        try:
            now = time.monotonic() - started_at
            if now - last_clock_sync >= clock_sync_interval:
                if use_mock_data:
                    for mock_clock in mock_clocks:
                        mock_clock.synchronize(now)
                else:
                    send_clock_sync(clock_sync_urls, int(time.time() * 1000))
                last_clock_sync = now

            if use_mock_data:
                samples = [
                    make_mock_sample(
                        now,
                        index + 1,
                        mock_clock.time_ms(now),
                        phase_offset=0.28 * index,
                        scale=1.0 + 0.12 * math.sin(index * 1.7),
                    )
                    for index, mock_clock in enumerate(mock_clocks)
                ]
            elif url:
                samples = fetch_samples(
                    url, timeout=max(2.0, current_poll_interval * 2)
                )
            else:
                samples = []
            for sample in samples:
                paddler_id = add_device(sample)
                if paddler_id is None:
                    continue
                x, y, z = accelerometer_values(sample)
                try:
                    sample_time = float(sample["device_ms"]) / 1000
                except (KeyError, TypeError, ValueError):
                    sample_time = now
                series = device_series[paddler_id]
                series["time"].append(sample_time)
                series["acceleration"].append(
                    math.sqrt(x * x + y * y + z * z)
                )

            if use_mock_data:
                fc_messages = [make_mock_fc_message(now)]
            elif fc_url:
                fc_messages = fetch_fc_messages(
                    fc_url, timeout=max(2.0, current_poll_interval * 2)
                )
            else:
                fc_messages = []
            position_messages = [
                message
                for message in fc_messages
                if message.get("mavpackettype") == "GLOBAL_POSITION_INT"
            ]
            if position_messages:
                position = position_messages[-1]
                speed = fc_velocity_magnitude(position)
                fc_time = float(position.get("time_boot_ms", now * 1000)) / 1000
                if previous_fc_time is not None:
                    time_delta = fc_time - previous_fc_time
                    if 0 < time_delta <= max(10.0, current_poll_interval * 5):
                        total_distance += speed * time_delta
                previous_fc_time = fc_time
                fc_times.append(fc_time)
                fc_distances.append(total_distance)
                fc_status.set_text(
                    f"Speed: {speed:.2f} m/s   Distance: {total_distance:.2f} m "
                    f"({'mock' if use_mock_data else 'endpoint'})"
                )
                fc_status.set_color("green")
            elif show_fc:
                fc_status.set_text("FC response contains no GLOBAL_POSITION_INT message")
                fc_status.set_color("darkorange")
            source = "mock data" if use_mock_data else "endpoint"
            status.set_text(f"Latest sample: {time.strftime('%H:%M:%S')} ({source})")
            status.set_color("green")
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
            status.set_text(f"Fetch error: {exc}")
            status.set_color("red")

        if device_series:
            for annotation in trough_annotations:
                annotation.remove()
            trough_annotations = []
            period_summaries = []
            for device_id, series in device_series.items():
                times = list(series["time"])
                acceleration = list(series["acceleration"])
                troughs = find_trough_indices(
                    times, acceleration, trough_min_distance
                )
                device_lines[device_id].set_data(times, acceleration)
                device_trough_lines[device_id].set_data(
                    [times[index] for index in troughs],
                    [acceleration[index] for index in troughs],
                )
                periods = [
                    times[right] - times[left]
                    for left, right in zip(troughs, troughs[1:])
                ]
                if periods:
                    name = device_lines[device_id].get_label()
                    period_summaries.append(
                        f"{name}: latest {periods[-1]:.2f}s, avg {sum(periods) / len(periods):.2f}s"
                    )
                    # Label recent intervals while keeping a long-running graph readable.
                    for left, right, period in list(zip(troughs, troughs[1:], periods))[-4:]:
                        annotation = axis.annotate(
                            f"{period:.2f}s",
                            ((times[left] + times[right]) / 2,
                             min(acceleration[left], acceleration[right])),
                            xytext=(0, -13), textcoords="offset points",
                            ha="center", va="top", fontsize=7,
                            color=device_lines[device_id].get_color(),
                        )
                        trough_annotations.append(annotation)
            if period_summaries:
                status.set_text(
                    f"Latest sample: {time.strftime('%H:%M:%S')} "
                    f"({'mock data' if use_mock_data else 'endpoint'})\n"
                    + "\n".join(period_summaries)
                )
            axis.relim()
            axis.autoscale_view()
        if fc_times:
            fc_distance_line.set_data(fc_times, fc_distances)
            fc_axis.relim()
            fc_axis.autoscale_view()
        artists = [
            status, fc_status, fc_distance_line,
            *device_lines.values(), *device_trough_lines.values(),
            *trough_annotations,
        ]
        return tuple(artists)

    plt.tight_layout(rect=(0, 0.09, 1, 1))
    slider_axis = figure.add_axes((0.25, 0.025, 0.5, 0.035))
    initial_poll_rate = 1.0 / poll_interval
    poll_rate_slider = Slider(
        ax=slider_axis,
        label="Polling rate (Hz)",
        valmin=0.5,
        valmax=max(50.0, initial_poll_rate),
        valinit=initial_poll_rate,
        valstep=0.5,
    )

    animation = FuncAnimation(
        figure,
        update,
        interval=int(current_poll_interval * 1000),
        cache_frame_data=False,
    )

    def change_poll_rate(rate_hz: float) -> None:
        nonlocal current_poll_interval
        current_poll_interval = 1.0 / rate_hz
        animation.event_source.interval = max(1, int(current_poll_interval * 1000))

    poll_rate_slider.on_changed(change_poll_rate)
    # Keep a reference for the lifetime of the interactive plot.
    figure._accelerometer_animation = animation  # type: ignore[attr-defined]
    figure._poll_rate_slider = poll_rate_slider  # type: ignore[attr-defined]
    plt.show()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
