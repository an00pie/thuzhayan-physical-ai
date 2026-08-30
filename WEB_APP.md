# Paddle telemetry web app

The Vite app polls the queued pad endpoint, groups every event by `paddler_id`,
plots raw acceleration magnitude, detects troughs, and measures the time between
them. It also retains the optional flight-controller distance graph and mock mode.

The root route (`/`) is the simplified mobile crew display. The complete graphing
and diagnostics workspace is available at `/debug`. A touch-friendly live Three.js
boat and crew view is available at `/visual`.

The original THUZHAYAN Physical AI dashboard is reproduced unchanged at
`/thuzhayan`. Its compatibility API is implemented by the Express server and
reuses `ACCELEROMETER_ENDPOINT_URL`, `FC_ENDPOINT_URL`, `OLLAMA_BASE_URL`, and
`OLLAMA_MODEL`; the existing Paddleline routes and frontend are independent.

Each paddler also receives a phase cue derived from the signed difference between
their latest matched trough timestamp and the other paddlers: `SPEED UP`,
`SLOW DOWN`, or `ON PACE`. It is calculated from the newest match, with a
configurable deadband for tiny offsets, but an existing judgment is held for two
seconds before it may change again.

The headline stroke score combines 40% trough timing, 40% multichannel waveform
shape (Dynamic Time Warping), and 20% linear-acceleration intensity. Missing
strokes contribute zero. Gravity is removed from acceleration using roll and
pitch when those orientation fields are present; raw graph data is not smoothed.

## Run it

Install Node.js 20.19 or newer, then run:

```bash
npm install
npm run dev
```

Open the address printed by Vite. The development proxy derives its upstreams
directly from `ACCELEROMETER_ENDPOINT_URL` and `FC_ENDPOINT_URL`, avoiding
browser CORS issues without duplicating host values.

For a production build, run `npm run build`. A production web server must either
proxy `/api/pad` in the same way or the telemetry server must allow cross-origin
requests and `VITE_PAD_ENDPOINT_URL` must contain its full URL at build time.

## PDF reports

Set `OLLAMA_BASE_URL` and `OLLAMA_MODEL` in `.env`. The defaults are
`http://100.126.17.82:11434` and `gemma3-local:latest`.
The mobile **Generate report** button snapshots the current browser session and
opens `/report`. That page generates a report through the server-side Ollama API,
provides a PDF download, and supports report-grounded follow-up questions.
