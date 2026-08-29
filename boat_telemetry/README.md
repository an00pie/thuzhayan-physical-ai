# Automatic boat telemetry

`sitl_reader.py` is the **boat-only telemetry service**. It continuously receives MAVLink packets,
converts the raw protocol values into physical boat values, and appends one normalized JSON record
per second. It has no dependency on the paddle sensor.

| MAVLink input | Automatic boat value |
| --- | --- |
| `GLOBAL_POSITION_INT.vx`, `.vy` | speed in m/s and km/h, course, GPS distance |
| `GLOBAL_POSITION_INT.hdg` | hull heading |
| heading minus course | drift, but only while the boat is moving |
| `ATTITUDE` | roll, pitch, yaw rate, 10-second yaw stability |
| `GPS_RAW_INT` | GPS fix health and satellite count |
| `SYS_STATUS` | battery voltage |

Run the locally built Rover/Boat SITL in one terminal:

```bash
work/ardupilot/build/sitl/bin/ardurover \
  --model motorboat --uartA udpclient:127.0.0.1:14550
```

Run the normalizer in a second terminal. `--seconds 45` makes this a bounded test; omit it for
the real continuous service and stop it with `Ctrl+C`.

```bash
PYTHONPATH="$PWD/work/ardupilot/modules/mavlink:$PWD/work/python-packages" \
  python3 boat_telemetry/sitl_reader.py \
  --source ardupilot_rover_sitl --seconds 45 --truncate
```

The result is `data/boat-telemetry.jsonl`. For real hardware, change only the connection and
give the flight controller a stable `/dev/serial/by-id/...` path rather than relying on a changing
`ttyUSB` number:

```bash
PYTHONPATH="$PWD/work/ardupilot/modules/mavlink:$PWD/work/python-packages" \
  python3 boat_telemetry/sitl_reader.py \
  --connection /dev/serial/by-id/YOUR_FLIGHT_CONTROLLER \
  --source physical_flight_controller
```

The future paddle service writes a separate `data/paddle-telemetry.jsonl` file. Analytics joins
the two streams by timestamp only; neither collector waits for or controls the other.

## Readable live summary

Keep the raw JSONL for the dashboard and analysis, then render its latest frame for people:

```bash
python3 boat_telemetry/readable_summary.py data/boat-telemetry.jsonl
```

## Live dashboard and post-run report

Start this in a third terminal while SITL and the telemetry reader are running:

```bash
python3 boat_telemetry/live_dashboard.py --log data/boat-telemetry.jsonl
```

Open `http://127.0.0.1:8080`. The animated water crests respond to current speed and yaw
stability, and the overall run report updates as telemetry arrives.

For the final text report after the run ends:

```bash
python3 boat_telemetry/final_report.py data/boat-telemetry.jsonl
```
