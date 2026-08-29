# Paddle telemetry boundary

The paddle accelerometer runs as a separate input pipeline from MAVLink boat telemetry. The paddle
unit should detect its own stroke events locally and send compact newline-delimited JSON over its
serial/ESP-NOW hub link. Do not send raw 100 Hz accelerometer samples to the Pi unless needed for
calibration.

The Pi-side paddle collector will append records in this shape:

```json
{"timestamp_unix_ms": 1787999051756, "paddle_id": 1, "event": "catch", "peak_accel_g": 1.72, "battery_mv": 3810}
```

For each 15–30 second report segment, its independent processor derives stroke rate, inter-stroke
consistency, mean peak acceleration, and effort trend. The reporting layer later aligns that
segment with the matching interval in `data/boat-telemetry.jsonl` to compare paddle behaviour with
boat speed and hull stability.

There is no crew-sync claim in the one-paddle prototype: it provides individual stroke coaching
and boat-response context only.
