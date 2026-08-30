import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const config = {
  padUrls: [import.meta.env.VITE_PAD_ENDPOINT_URL].filter(Boolean),
  fcUrl: import.meta.env.VITE_FC_ENDPOINT_URL || "",
  mock: String(import.meta.env.VITE_USE_MOCK_DATA || "false").toLowerCase() === "true",
  maxPoints: Number(import.meta.env.VITE_MAX_POINTS || 300),
  paddles: Number(import.meta.env.VITE_MOCK_PADDLE_COUNT || 3),
  minTroughDistance: Number(import.meta.env.VITE_TROUGH_MIN_DISTANCE_SECONDS || 0.6),
  troughMatchTolerance: Number(import.meta.env.VITE_TROUGH_MATCH_TOLERANCE_SECONDS || 0.5),
  paceDeadbandMs: Number(import.meta.env.VITE_PACE_DEADBAND_MS || 40),
  paceGuidanceHoldMs: Number(import.meta.env.VITE_PACE_GUIDANCE_HOLD_MS || 2000),
  clockSyncUrls: String(import.meta.env.VITE_CLOCK_SYNC_ENDPOINT_URLS || "").split(",").map((url) => url.trim()).filter(Boolean),
  clockSyncMs: Number(import.meta.env.VITE_CLOCK_SYNC_INTERVAL_MS || 30000),
};

const colors = ["#1455ff", "#e54d2e", "#009b72", "#8e4ec6", "#d19d00", "#d2316f"];
const state = {
  paddlers: new Map(),
  fc: [],
  totalDistance: 0,
  previousFcTime: null,
  timer: null,
  startedAt: performance.now(),
  startedWallClock: new Date().toISOString(),
  fetching: false,
  running: true,
  lastClockSync: -Infinity,
  lastAnalysisTime: null,
  analysisTotals: { overall: 0, timing: 0, shape: 0, intensity: 0 },
  analysisCounts: { overall: 0, timing: 0, shape: 0, intensity: 0 },
  latestAnalysis: null,
  paceGuidance: new Map(),
};

const debugView = `
  <section class="workspace">
    <section class="output">
      <div class="output-title">
        <div><p class="section-number">LIVE / OUTPUT</p><h2>Telemetry workspace</h2></div>
        <div class="stream-controls">
          <div class="connection"><span id="connection-dot"></span><span id="connection-label">Waiting</span></div>
          <button id="pause">Pause stream</button>
        </div>
      </div>
      <section class="metrics" id="metrics"></section>
      <div class="graphs">
        <article class="panel" id="pad-panel">
          <div class="panel-heading"><div><p class="kicker">ACCELEROMETER</p><h3>Acceleration & stroke periods</h3></div><span>MAGNITUDE / G</span></div>
          <svg id="pad-chart" role="img" aria-label="Paddle acceleration chart"></svg>
          <div class="legend" id="legend"></div>
        </article>
        <article class="panel interval-panel" id="interval-panel">
          <div class="panel-heading">
            <div><p class="kicker">RHYTHM COMPARISON</p><h3>Trough timestamp alignment</h3></div>
            <div class="score"><strong id="match-score">—</strong><span>MATCH</span></div>
          </div>
          <svg id="interval-chart" role="img" aria-label="Paddle trough timestamp alignment chart"></svg>
          <p class="chart-note" id="match-note">Waiting for troughs from at least two paddles.</p>
        </article>
        <article class="panel" id="fc-panel">
          <div class="panel-heading"><div><p class="kicker">FLIGHT CONTROLLER</p><h3>Distance travelled</h3></div><span>METRES</span></div>
          <svg id="fc-chart" role="img" aria-label="Flight controller distance chart"></svg>
        </article>
      </div>
      <p class="error" id="error"></p>
    </section>
  </section>
`;

const mobileView = `
  <main class="mobile-dashboard">
    <section class="mobile-score-card">
      <p>CREW STROKE MATCH</p>
      <strong id="match-score">—</strong>
      <div class="mobile-fc-summary" id="fc-summary" hidden></div>
    </section>
    <section class="mobile-readings" id="metrics"></section>
    <p class="error" id="error"></p>
    <footer class="report-actions">
      <button id="make-report">Generate report</button>
      <span id="report-status"></span>
    </footer>
  </main>
`;

const visualView = `
  <main class="visual-dashboard">
    <div class="visual-heading">
      <div><p class="section-number">03 / VISUAL</p><h1>Boat motion</h1></div>
      <div class="visual-score"><span>STROKE MATCH</span><strong id="match-score">—</strong></div>
    </div>
    <section class="visual-stage">
      <canvas id="boat-canvas" aria-label="Live 3D visualization of the paddling crew"></canvas>
      <div class="visual-hint">DRAG TO ORBIT · PINCH TO ZOOM</div>
    </section>
    <div class="visual-footer">
      <span id="visual-status">Waiting for paddlers</span>
      <nav><a href="/">Crew</a><a href="/debug">Debug</a></nav>
    </div>
    <p class="error" id="error"></p>
  </main>
`;

const reportView = `
  <main class="report-dashboard">
    <header class="report-heading">
      <div><p class="section-number">04 / REPORT</p><h1>Run analysis</h1></div>
      <div class="report-heading-actions">
        <span id="report-page-status">Generating analysis…</span>
        <div class="pdf-download-control">
          <button id="download-report" disabled>Download PDF</button>
          <div id="pdf-progress" class="generation-progress indeterminate" role="progressbar" aria-label="Report generation progress"><i></i></div>
        </div>
        <a href="/">Back to crew</a>
      </div>
    </header>
    <section class="report-chat">
      <div class="report-copy-heading"><h2>Ask about this run</h2><span>REPORT-GROUNDED</span></div>
      <div id="report-messages" class="report-messages"><p>Generate the report to ask questions about timing, technique, or crew consistency.</p></div>
      <form id="report-question-form">
        <input id="report-question" type="text" autocomplete="off" placeholder="Type a question while the analysis is generated…" />
        <button type="submit" disabled>Ask</button>
      </form>
    </section>
    <p class="error" id="error"></p>
  </main>
`;

const currentRoute = window.location.pathname.replace(/\/$/, "");
const isDebugView = currentRoute === "/debug";
const isVisualView = currentRoute === "/visual";
const isReportView = currentRoute === "/report";
document.querySelector("#app").innerHTML = isDebugView
  ? debugView
  : isVisualView
    ? visualView
    : isReportView
      ? reportView
      : mobileView;

const elements = {
  padPanel: document.querySelector("#pad-panel"), fcPanel: document.querySelector("#fc-panel"),
  padChart: document.querySelector("#pad-chart"), fcChart: document.querySelector("#fc-chart"),
  intervalChart: document.querySelector("#interval-chart"),
  metrics: document.querySelector("#metrics"), legend: document.querySelector("#legend"),
  error: document.querySelector("#error"), dot: document.querySelector("#connection-dot"),
  connection: document.querySelector("#connection-label"), pause: document.querySelector("#pause"),
  matchScore: document.querySelector("#match-score"), matchNote: document.querySelector("#match-note"),
  fcSummary: document.querySelector("#fc-summary"),
  reportButton: document.querySelector("#make-report"), reportStatus: document.querySelector("#report-status"),
  boatCanvas: document.querySelector("#boat-canvas"), visualStatus: document.querySelector("#visual-status"),
  reportPageStatus: document.querySelector("#report-page-status"),
  downloadReport: document.querySelector("#download-report"),
  pdfProgress: document.querySelector("#pdf-progress"),
  reportMessages: document.querySelector("#report-messages"),
  reportQuestionForm: document.querySelector("#report-question-form"),
  reportQuestion: document.querySelector("#report-question"),
};

if (elements.padPanel) elements.padPanel.hidden = !config.mock && !config.padUrls.length;
if (elements.fcPanel) elements.fcPanel.hidden = !config.mock && !config.fcUrl;
function paddlerId(event) {
  if (event?.paddler_id === undefined || event?.paddler_id === null) throw new Error("Pad event is missing paddler_id");
  return String(event.paddler_id);
}

function acceleration(event) {
  if (Number.isFinite(Number(event.accel_magnitude_g))) return Number(event.accel_magnitude_g);
  const { x, y, z } = event.accel_g || {};
  if (![x, y, z].every((value) => Number.isFinite(Number(value)))) throw new Error("Pad event is missing acceleration data");
  return Math.hypot(Number(x), Number(y), Number(z));
}

function motionChannels(event) {
  const acceleration = event.accel_g || {};
  const gyro = event.gyro_dps || {};
  const roll = Number(event.orientation_deg?.roll) * Math.PI / 180;
  const pitch = Number(event.orientation_deg?.pitch) * Math.PI / 180;
  const ax = Number(acceleration.x) || 0, ay = Number(acceleration.y) || 0, az = Number(acceleration.z) || 0;
  let gravityX = 0, gravityY = 0, gravityZ = 1;
  if (Number.isFinite(roll) && Number.isFinite(pitch)) {
    gravityX = -Math.sin(pitch);
    gravityY = Math.sin(roll) * Math.cos(pitch);
    gravityZ = Math.cos(roll) * Math.cos(pitch);
  }
  return [
    ax - gravityX,
    ay - gravityY,
    az - gravityZ,
    (Number(gyro.x) || 0) / 100,
    (Number(gyro.y) || 0) / 100,
    (Number(gyro.z) || 0) / 100,
  ];
}

function addPadEvents(events) {
  for (const event of events) {
    const id = paddlerId(event);
    if (!state.paddlers.has(id)) state.paddlers.set(id, {
      id, name: event.device_name || `Paddler ${id}`, points: [],
      totalSamples: 0, accelerationSum: 0, accelerationMin: Infinity, accelerationMax: -Infinity,
      firstTime: null, lastTime: null,
    });
    const series = state.paddlers.get(id);
    series.name = event.device_name || series.name;
    const sampleTime = Number(event.device_ms) / 1000;
    const magnitude = acceleration(event);
    series.points.push({
      time: sampleTime,
      value: magnitude,
      channels: motionChannels(event),
      receivedAt: performance.now(),
    });
    series.totalSamples += 1;
    series.accelerationSum += magnitude;
    series.accelerationMin = Math.min(series.accelerationMin, magnitude);
    series.accelerationMax = Math.max(series.accelerationMax, magnitude);
    series.firstTime ??= sampleTime;
    series.lastTime = sampleTime;
    if (series.points.length > config.maxPoints) series.points.splice(0, series.points.length - config.maxPoints);
  }
}

function addFcMessages(messages) {
  const positions = messages.filter((message) => message.mavpackettype === "GLOBAL_POSITION_INT");
  if (!positions.length) return;
  const item = positions.at(-1);
  const time = Number(item.time_boot_ms) / 1000;
  const speed = Math.hypot(Number(item.vx), Number(item.vy), Number(item.vz)) / 100;
  if (state.previousFcTime !== null) {
    const delta = time - state.previousFcTime;
    if (delta > 0 && delta <= 10) state.totalDistance += speed * delta;
  }
  state.previousFcTime = time;
  state.fc.push({ time, value: state.totalDistance, speed });
  if (state.fc.length > config.maxPoints) state.fc.splice(0, state.fc.length - config.maxPoints);
}

function troughs(points) {
  if (points.length < 7) return [];
  const values = points.map((point) => point.value);
  const range = Math.max(...values) - Math.min(...values);
  const minimumProminence = Math.max(0.005, range * 0.06);
  const candidates = [];
  const radius = 2;
  const prominenceRadius = Math.max(3, Math.min(15, Math.floor(points.length / 6)));
  for (let index = radius; index < points.length - radius; index += 1) {
    const local = values.slice(index - radius, index + radius + 1);
    if (values[index] !== Math.min(...local)) continue;
    const left = values.slice(Math.max(0, index - prominenceRadius), index);
    const right = values.slice(index + 1, Math.min(values.length, index + prominenceRadius + 1));
    if (Math.min(Math.max(...left), Math.max(...right)) - values[index] >= minimumProminence) candidates.push(index);
  }
  const result = [];
  for (const index of candidates) {
    const previous = result.at(-1);
    if (previous === undefined || points[index].time - points[previous].time >= config.minTroughDistance) result.push(index);
    else if (values[index] < values[previous]) result[result.length - 1] = index;
  }
  return result;
}

function troughTimestampSeries(paddlers) {
  return paddlers.map((paddler, index) => {
    const found = troughs(paddler.points);
    const points = found.map((troughIndex) => ({ time: paddler.points[troughIndex].time }));
    return {
      id: paddler.id,
      name: paddler.name,
      color: colors[index % colors.length],
      points,
      observationStart: paddler.points[0]?.time,
      observationEnd: paddler.points.at(-1)?.time,
    };
  });
}

function troughTimestampMatch(seriesList) {
  const usable = seriesList.filter(
    (series) => Number.isFinite(series.observationStart) && Number.isFinite(series.observationEnd)
  );
  const pairScores = [];
  for (let leftIndex = 0; leftIndex < usable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < usable.length; rightIndex += 1) {
      const left = usable[leftIndex], right = usable[rightIndex];
      // Score the entire period where both sensors supplied raw data. This makes
      // missing troughs count as zero rather than trimming them out of the window.
      const overlapStart = Math.max(left.observationStart, right.observationStart);
      const overlapEnd = Math.min(left.observationEnd, right.observationEnd);
      if (overlapEnd < overlapStart) continue;
      const leftTimes = left.points.map((point) => point.time).filter((time) => time >= overlapStart && time <= overlapEnd);
      const rightTimes = right.points.map((point) => point.time).filter((time) => time >= overlapStart && time <= overlapEnd);
      const unusedRight = new Set(rightTimes.map((_time, index) => index));
      const matches = [];
      leftTimes.forEach((leftTime) => {
        let nearestIndex = null, nearestDelta = Infinity;
        unusedRight.forEach((index) => {
          const delta = Math.abs(leftTime - rightTimes[index]);
          if (delta < nearestDelta) { nearestDelta = delta; nearestIndex = index; }
        });
        if (nearestIndex !== null && nearestDelta <= config.troughMatchTolerance) {
          unusedRight.delete(nearestIndex);
          matches.push({ leftTime, rightTime: rightTimes[nearestIndex], delta: nearestDelta });
        }
      });
      const expectedMatches = Math.max(leftTimes.length, rightTimes.length);
      if (expectedMatches) pairScores.push({
        names: `${left.name} ↔ ${right.name}`,
        leftId: left.id,
        rightId: right.id,
        matches,
        expectedMatches,
        score: matches.reduce(
          (sum, match) => sum + Math.max(0, 1 - match.delta / config.troughMatchTolerance), 0
        ) / expectedMatches * 100,
      });
    }
  }
  if (!pairScores.length) return { score: null, pairs: [] };
  return {
    score: pairScores.reduce((sum, pair) => sum + pair.score, 0) / pairScores.length,
    pairs: pairScores,
  };
}

function paceGuidance(paddlers, pairResults) {
  const signedOffsets = new Map(paddlers.map((paddler) => [paddler.id, []]));
  pairResults.forEach((pair) => {
    const latest = pair.matches.at(-1);
    if (!latest) return;
    const leftOffsetMs = (latest.leftTime - latest.rightTime) * 1000;
    signedOffsets.get(pair.leftId)?.push(leftOffsetMs);
    signedOffsets.get(pair.rightId)?.push(-leftOffsetMs);
  });
  return new Map(paddlers.map((paddler) => {
    const offsets = signedOffsets.get(paddler.id) || [];
    if (!offsets.length) return [paddler.id, { action: "WAIT", detail: "Need matched troughs", className: "waiting" }];
    const offsetMs = offsets.reduce((sum, value) => sum + value, 0) / offsets.length;
    if (Math.abs(offsetMs) <= config.paceDeadbandMs) {
      return [paddler.id, { action: "ON PACE", detail: `${Math.round(Math.abs(offsetMs))} ms offset`, className: "on-pace" }];
    }
    if (offsetMs > 0) {
      return [paddler.id, { action: "SPEED UP", detail: `${Math.round(offsetMs)} ms behind`, className: "speed-up" }];
    }
    return [paddler.id, { action: "SLOW DOWN", detail: `${Math.round(Math.abs(offsetMs))} ms ahead`, className: "slow-down" }];
  }));
}

function heldPaceGuidance(rawGuidance) {
  const now = performance.now();
  const held = new Map();
  for (const [id, next] of rawGuidance) {
    const current = state.paceGuidance.get(id);
    if (!current || current.cue.action === "WAIT" || next.action === "WAIT") {
      state.paceGuidance.set(id, { cue: next, changedAt: now });
    } else if (current.cue.action === next.action) {
      current.cue = next;
    } else if (now - current.changedAt >= config.paceGuidanceHoldMs) {
      state.paceGuidance.set(id, { cue: next, changedAt: now });
    }
    held.set(id, state.paceGuidance.get(id).cue);
  }
  for (const id of state.paceGuidance.keys()) {
    if (!rawGuidance.has(id)) state.paceGuidance.delete(id);
  }
  return held;
}

function resampleStroke(points, sampleCount = 48) {
  if (points.length < 3) return null;
  const start = points[0].time, end = points.at(-1).time;
  if (end <= start) return null;
  const sampled = [];
  let sourceIndex = 1;
  for (let index = 0; index < sampleCount; index += 1) {
    const time = start + index / (sampleCount - 1) * (end - start);
    while (sourceIndex < points.length - 1 && points[sourceIndex].time < time) sourceIndex += 1;
    const left = points[sourceIndex - 1], right = points[sourceIndex];
    const ratio = right.time === left.time ? 0 : (time - left.time) / (right.time - left.time);
    sampled.push(left.channels.map((value, channel) => value + (right.channels[channel] - value) * ratio));
  }
  const channelCount = sampled[0].length;
  const means = Array.from({ length: channelCount }, (_, channel) =>
    sampled.reduce((sum, row) => sum + row[channel], 0) / sampled.length
  );
  const deviations = means.map((mean, channel) => Math.sqrt(
    sampled.reduce((sum, row) => sum + (row[channel] - mean) ** 2, 0) / sampled.length
  ) || 1);
  return sampled.map((row) => row.map((value, channel) => (value - means[channel]) / deviations[channel]));
}

function buildStrokes(paddler) {
  const found = troughs(paddler.points);
  return found.slice(1).map((right, index) => {
    const left = found[index];
    const raw = paddler.points.slice(left, right + 1);
    const duration = paddler.points[right].time - paddler.points[left].time;
    const intensity = raw.reduce((sum, point) => {
      const [x, y, z] = point.channels;
      return sum + Math.hypot(x, y, z);
    }, 0) / raw.length;
    return {
      start: paddler.points[left].time,
      end: paddler.points[right].time,
      duration,
      intensity,
      waveform: resampleStroke(raw),
    };
  }).filter((stroke) => stroke.waveform);
}

function dtwSimilarity(left, right) {
  const rows = left.length, columns = right.length;
  const previous = new Float64Array(columns + 1).fill(Infinity);
  const current = new Float64Array(columns + 1);
  previous[0] = 0;
  const window = Math.max(6, Math.abs(rows - columns));
  for (let row = 1; row <= rows; row += 1) {
    current.fill(Infinity);
    for (let column = Math.max(1, row - window); column <= Math.min(columns, row + window); column += 1) {
      const distance = Math.sqrt(left[row - 1].reduce(
        (sum, value, channel) => sum + (value - right[column - 1][channel]) ** 2, 0
      ) / left[row - 1].length);
      current[column] = distance + Math.min(previous[column], current[column - 1], previous[column - 1]);
    }
    previous.set(current);
  }
  const normalizedDistance = previous[columns] / (rows + columns);
  return Math.exp(-normalizedDistance) * 100;
}

function strokeSimilarity(paddlers) {
  const series = paddlers.map((paddler) => ({ ...paddler, strokes: buildStrokes(paddler) }));
  const shapeScores = [], intensityScores = [];
  for (let leftIndex = 0; leftIndex < series.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < series.length; rightIndex += 1) {
      const leftSeries = series[leftIndex], rightSeries = series[rightIndex];
      const overlapStart = Math.max(leftSeries.points[0]?.time ?? Infinity, rightSeries.points[0]?.time ?? Infinity);
      const overlapEnd = Math.min(leftSeries.points.at(-1)?.time ?? -Infinity, rightSeries.points.at(-1)?.time ?? -Infinity);
      if (overlapEnd < overlapStart) continue;
      const left = leftSeries.strokes.filter((stroke) => stroke.start >= overlapStart && stroke.end <= overlapEnd);
      const right = rightSeries.strokes.filter((stroke) => stroke.start >= overlapStart && stroke.end <= overlapEnd);
      const unusedRight = new Set(right.map((_stroke, index) => index));
      const matched = [];
      left.forEach((leftStroke) => {
        let nearest = null, nearestDelta = Infinity;
        unusedRight.forEach((index) => {
          const delta = Math.abs(leftStroke.start - right[index].start);
          if (delta < nearestDelta) { nearest = index; nearestDelta = delta; }
        });
        if (nearest !== null && nearestDelta <= config.troughMatchTolerance) {
          unusedRight.delete(nearest);
          matched.push([leftStroke, right[nearest]]);
        }
      });
      const expected = Math.max(left.length, right.length);
      if (!expected) continue;
      const shapeTotal = matched.reduce((sum, [a, b]) => sum + dtwSimilarity(a.waveform, b.waveform), 0);
      const intensityTotal = matched.reduce((sum, [a, b]) => {
        const maximum = Math.max(a.intensity, b.intensity);
        return sum + (maximum ? Math.min(a.intensity, b.intensity) / maximum * 100 : 100);
      }, 0);
      shapeScores.push(shapeTotal / expected);
      intensityScores.push(intensityTotal / expected);
    }
  }
  return {
    shape: shapeScores.length ? shapeScores.reduce((a, b) => a + b, 0) / shapeScores.length : null,
    intensity: intensityScores.length ? intensityScores.reduce((a, b) => a + b, 0) / intensityScores.length : null,
  };
}

const visualState = { scene: null, camera: null, renderer: null, controls: null, boat: null, paddlerModels: new Map() };

function outlinedMesh(geometry, material, outlineColor = 0x1455ff) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  group.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, 25),
    new THREE.LineBasicMaterial({ color: outlineColor })
  ));
  return group;
}

function makePaddlerModel(index) {
  const group = new THREE.Group();
  const blue = new THREE.MeshStandardMaterial({ color: 0xf8faff, roughness: 0.75 });
  const accent = new THREE.MeshStandardMaterial({ color: colors[index % colors.length], roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x17203a, roughness: 0.8 });
  const seat = outlinedMesh(new THREE.BoxGeometry(0.72, 0.12, 0.88), blue);
  seat.position.y = 0.38;
  group.add(seat);
  const torso = outlinedMesh(new THREE.CapsuleGeometry(0.23, 0.48, 4, 8), accent);
  torso.position.y = 0.88;
  group.add(torso);
  const head = outlinedMesh(new THREE.SphereGeometry(0.19, 12, 8), blue);
  head.position.y = 1.39;
  group.add(head);

  const side = index % 2 ? -1 : 1;
  const paddle = new THREE.Group();
  paddle.position.set(0, 1.02, side * 0.55);
  const shaft = outlinedMesh(new THREE.CylinderGeometry(0.028, 0.028, 2.45, 8), dark);
  shaft.position.y = -0.62;
  paddle.add(shaft);
  const blade = outlinedMesh(new THREE.BoxGeometry(0.23, 0.55, 0.055), accent);
  blade.position.y = -1.95;
  paddle.add(blade);
  group.add(paddle);
  return { group, paddle, torso, side };
}

function initializeVisual() {
  if (!isVisualView || !elements.boatCanvas) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf7f9ff);
  scene.fog = new THREE.Fog(0xf7f9ff, 13, 28);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(7.5, 5.4, 8.5);
  const renderer = new THREE.WebGLRenderer({ canvas: elements.boatCanvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.7, 0);
  controls.minDistance = 5;
  controls.maxDistance = 18;
  controls.maxPolarAngle = Math.PI * 0.48;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c9ff, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.8);
  sun.position.set(4, 9, 6);
  sun.castShadow = true;
  scene.add(sun);
  const grid = new THREE.GridHelper(30, 30, 0x1455ff, 0xcbd8ff);
  grid.position.y = -0.58;
  scene.add(grid);

  const boat = new THREE.Group();
  const hullMaterial = new THREE.MeshStandardMaterial({ color: 0x1455ff, roughness: 0.5, metalness: 0.05 });
  const hull = outlinedMesh(new THREE.CapsuleGeometry(0.62, 5.6, 8, 20), hullMaterial, 0x0b2c8f);
  hull.rotation.z = Math.PI / 2;
  hull.scale.z = 0.68;
  hull.position.y = 0;
  boat.add(hull);
  const rim = outlinedMesh(new THREE.BoxGeometry(5.7, 0.09, 0.9), new THREE.MeshStandardMaterial({ color: 0xffffff }));
  rim.position.y = 0.37;
  boat.add(rim);
  scene.add(boat);

  visualState.scene = scene; visualState.camera = camera; visualState.renderer = renderer;
  visualState.controls = controls; visualState.boat = boat;
  const resize = () => {
    const width = elements.boatCanvas.clientWidth, height = elements.boatCanvas.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(elements.boatCanvas);
  resize();
  renderer.setAnimationLoop(animateVisual);
}

function updateVisualPaddlers() {
  if (!visualState.boat) return;
  const paddlers = [...state.paddlers.values()];
  paddlers.forEach((paddler, index) => {
    if (!visualState.paddlerModels.has(paddler.id)) {
      const model = makePaddlerModel(index);
      visualState.paddlerModels.set(paddler.id, model);
      visualState.boat.add(model.group);
    }
  });
  const spacing = Math.min(1.35, 5 / Math.max(1, paddlers.length));
  paddlers.forEach((paddler, index) => {
    const model = visualState.paddlerModels.get(paddler.id);
    model.group.position.x = (index - (paddlers.length - 1) / 2) * spacing;
  });
  if (elements.visualStatus) elements.visualStatus.textContent = paddlers.length
    ? `${paddlers.length} paddler${paddlers.length === 1 ? "" : "s"} connected`
    : "Waiting for paddlers";
}

function animateVisual(now) {
  if (!visualState.renderer) return;
  const paddlers = [...state.paddlers.values()];
  let motion = 0;
  paddlers.forEach((paddler) => {
    const model = visualState.paddlerModels.get(paddler.id);
    if (!model) return;
    const latest = paddler.points.at(-1);
    if (latest) {
      const [, , , gyroX, gyroY, gyroZ] = latest.channels;
      const targetForeAft = THREE.MathUtils.clamp(gyroX * 1.5, -0.95, 0.95);
      const targetDip = model.side * (
        0.24 + THREE.MathUtils.clamp(-gyroY * 0.9, -0.34, 0.34)
      );
      const targetTwist = THREE.MathUtils.clamp(gyroZ * 1.1, -0.55, 0.55);
      model.paddle.rotation.z = THREE.MathUtils.lerp(model.paddle.rotation.z, targetForeAft, 0.14);
      model.paddle.rotation.x = THREE.MathUtils.lerp(model.paddle.rotation.x, targetDip, 0.14);
      model.paddle.rotation.y = THREE.MathUtils.lerp(model.paddle.rotation.y, targetTwist, 0.14);
      model.torso.rotation.z = THREE.MathUtils.lerp(model.torso.rotation.z, targetForeAft * 0.18, 0.1);
      motion += Math.hypot(...latest.channels.slice(0, 3));
    }
  });
  if (visualState.boat) {
    const normalizedMotion = paddlers.length ? motion / paddlers.length : 0;
    visualState.boat.position.y = Math.sin(now / 650) * 0.025 + Math.min(0.05, normalizedMotion * 0.02);
    visualState.boat.rotation.x = Math.sin(now / 1100) * 0.012;
  }
  visualState.controls.update();
  visualState.renderer.render(visualState.scene, visualState.camera);
}

function svgNode(name, attributes = {}, text = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  node.textContent = text;
  return node;
}

function drawTroughAlignment(svg, seriesList, pairResults) {
  svg.replaceChildren();
  const usable = seriesList.filter((series) => series.points.length);
  const width = svg.clientWidth || 800, height = svg.clientHeight || 420;
  const margin = { left: 92, right: 22, top: 28, bottom: 42 };
  const allTimes = usable.flatMap((series) => series.points.map((point) => point.time));
  if (usable.length < 2 || !allTimes.length) {
    svg.append(svgNode("text", { x: width / 2, y: height / 2, class: "empty", "text-anchor": "middle" }, "Waiting for two trough streams…"));
    return;
  }
  let minTime = Math.min(...allTimes), maxTime = Math.max(...allTimes);
  if (minTime === maxTime) maxTime += 1;
  const x = (time) => margin.left + (time - minTime) / (maxTime - minTime) * (width - margin.left - margin.right);
  const rowGap = (height - margin.top - margin.bottom) / Math.max(1, usable.length - 1);
  const rowY = new Map(usable.map((series, index) => [series.id, margin.top + index * rowGap]));

  for (let tick = 0; tick <= 5; tick += 1) {
    const time = minTime + tick * (maxTime - minTime) / 5;
    const px = x(time);
    svg.append(svgNode("line", { x1: px, y1: margin.top, x2: px, y2: height - margin.bottom, class: "grid" }));
    svg.append(svgNode("text", { x: px, y: height - 15, class: "axis-label", "text-anchor": "middle" }, `${time.toFixed(1)}s`));
  }
  usable.forEach((series) => {
    const py = rowY.get(series.id);
    svg.append(svgNode("line", { x1: margin.left, y1: py, x2: width - margin.right, y2: py, class: "trough-row" }));
    svg.append(svgNode("text", { x: margin.left - 10, y: py + 4, fill: series.color, class: "axis-label", "text-anchor": "end" }, series.name));
    series.points.forEach((point) => svg.append(svgNode("line", {
      x1: x(point.time), y1: py - 9, x2: x(point.time), y2: py + 9,
      stroke: series.color, class: "trough-tick",
    })));
  });
  pairResults.forEach((pair) => {
    const leftY = rowY.get(pair.leftId), rightY = rowY.get(pair.rightId);
    if (leftY === undefined || rightY === undefined) return;
    pair.matches.slice(-10).forEach((match) => {
      const leftX = x(match.leftTime), rightX = x(match.rightTime);
      svg.append(svgNode("line", { x1: leftX, y1: leftY, x2: rightX, y2: rightY, class: "match-connector" }));
      svg.append(svgNode("text", {
        x: (leftX + rightX) / 2 + 4, y: (leftY + rightY) / 2 - 4,
        class: "delta-label", "text-anchor": "start",
      }, `${Math.round(match.delta * 1000)}ms`));
    });
  });
}

function drawChart(svg, seriesList, { troughMarkers = false } = {}) {
  svg.replaceChildren();
  const width = svg.clientWidth || 800, height = svg.clientHeight || 420;
  const margin = { left: 54, right: 22, top: 18, bottom: 42 };
  const all = seriesList.flatMap((series) => series.points);
  if (!all.length) {
    svg.append(svgNode("text", { x: width / 2, y: height / 2, class: "empty", "text-anchor": "middle" }, "Waiting for data…"));
    return;
  }
  let minX = Math.min(...all.map((p) => p.time)), maxX = Math.max(...all.map((p) => p.time));
  let minY = Math.min(...all.map((p) => p.value)), maxY = Math.max(...all.map((p) => p.value));
  if (maxX === minX) maxX += 1;
  if (maxY === minY) { minY -= 0.5; maxY += 0.5; }
  const yPad = (maxY - minY) * 0.12; minY -= yPad; maxY += yPad;
  const x = (value) => margin.left + ((value - minX) / (maxX - minX)) * (width - margin.left - margin.right);
  const y = (value) => height - margin.bottom - ((value - minY) / (maxY - minY)) * (height - margin.top - margin.bottom);

  for (let tick = 0; tick <= 5; tick += 1) {
    const py = margin.top + tick * (height - margin.top - margin.bottom) / 5;
    const value = maxY - tick * (maxY - minY) / 5;
    svg.append(svgNode("line", { x1: margin.left, y1: py, x2: width - margin.right, y2: py, class: "grid" }));
    svg.append(svgNode("text", { x: margin.left - 9, y: py + 4, class: "axis-label", "text-anchor": "end" }, value.toFixed(2)));
  }
  for (let tick = 0; tick <= 5; tick += 1) {
    const px = margin.left + tick * (width - margin.left - margin.right) / 5;
    const value = minX + tick * (maxX - minX) / 5;
    svg.append(svgNode("text", { x: px, y: height - 15, class: "axis-label", "text-anchor": "middle" }, `${value.toFixed(1)}s`));
  }
  seriesList.forEach((series, seriesIndex) => {
    if (!series.points.length) return;
    const color = series.color || colors[seriesIndex % colors.length];
    const path = series.points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    svg.append(svgNode("path", { d: path, fill: "none", stroke: color, class: troughMarkers ? "pad-line" : "fc-line" }));
    if (!troughMarkers) return;
    const indices = troughs(series.points);
    indices.forEach((index) => svg.append(svgNode("path", { d: `M${x(series.points[index].time)-5},${y(series.points[index].value)-8} l10,0 l-5,8 z`, fill: color })));
    indices.slice(-5).forEach((right, index, recent) => {
      if (!index) return;
      const left = recent[index - 1];
      const period = series.points[right].time - series.points[left].time;
      svg.append(svgNode("text", { x: (x(series.points[left].time) + x(series.points[right].time)) / 2, y: Math.min(height - margin.bottom - 5, y(series.points[right].value) + 22), fill: color, class: "period", "text-anchor": "middle" }, `${period.toFixed(2)}s`));
    });
  });
}

function render() {
  const paddlers = [...state.paddlers.values()];
  const troughSeries = troughTimestampSeries(paddlers);
  const match = troughTimestampMatch(troughSeries);
  const similarity = strokeSimilarity(paddlers);
  const components = [
    { value: match.score, weight: 0.4 },
    { value: similarity.shape, weight: 0.4 },
    { value: similarity.intensity, weight: 0.2 },
  ].filter((component) => component.value !== null);
  const componentWeight = components.reduce((sum, component) => sum + component.weight, 0);
  const overallScore = componentWeight
    ? components.reduce((sum, component) => sum + component.value * component.weight, 0) / componentWeight
    : null;
  state.latestAnalysis = { overall: overallScore, timing: match.score, shape: similarity.shape, intensity: similarity.intensity, match };
  const latestAnalysisTime = Math.max(...paddlers.map((paddler) => paddler.points.at(-1)?.time ?? -Infinity));
  if (Number.isFinite(latestAnalysisTime) && latestAnalysisTime !== state.lastAnalysisTime) {
    state.lastAnalysisTime = latestAnalysisTime;
    for (const [key, value] of Object.entries({ overall: overallScore, timing: match.score, shape: similarity.shape, intensity: similarity.intensity })) {
      if (value !== null) { state.analysisTotals[key] += value; state.analysisCounts[key] += 1; }
    }
  }
  const guidance = heldPaceGuidance(paceGuidance(paddlers, match.pairs));
  elements.matchScore.textContent = overallScore === null ? "—" : `${overallScore.toFixed(1)}%`;
  if (isVisualView) {
    updateVisualPaddlers();
    return;
  }
  if (isDebugView) {
    drawChart(elements.padChart, paddlers, { troughMarkers: true });
    drawTroughAlignment(elements.intervalChart, troughSeries, match.pairs);
    drawChart(elements.fcChart, [{ points: state.fc, color: "#8e4ec6" }]);
    elements.matchNote.textContent = match.pairs.length
      ? `Timing ${match.score.toFixed(1)}% · Shape ${similarity.shape?.toFixed(1) ?? "—"}% · Intensity ${similarity.intensity?.toFixed(1) ?? "—"}% / `
        + match.pairs.map((pair) => `${pair.names}: ${pair.matches.length}/${pair.expectedMatches} timed strokes`).join("  /  ")
      : "Waiting for overlapping trough timestamps from at least two paddles.";
    elements.legend.innerHTML = paddlers.map((p, i) => `<span><i style="--color:${colors[i % colors.length]}"></i>${p.name}</span>`).join("");
    elements.metrics.innerHTML = paddlers.map((p, i) => {
      const found = troughs(p.points);
      const periods = found.slice(1).map((right, j) => p.points[right].time - p.points[found[j]].time);
      const latest = periods.at(-1), average = periods.length ? periods.reduce((a, b) => a + b, 0) / periods.length : null;
      const cue = guidance.get(p.id);
      return `<article><span style="--color:${colors[i % colors.length]}">${p.name}</span><strong>${latest ? `${latest.toFixed(2)} s` : "—"}</strong><small>${average ? `average ${average.toFixed(2)} s` : "detecting troughs"}</small><em class="pace-cue ${cue.className}">${cue.action} · ${cue.detail}</em></article>`;
    }).join("");
    return;
  }

  const latestFc = state.fc.at(-1);
  if (latestFc) {
    elements.fcSummary.hidden = false;
    elements.fcSummary.innerHTML = `
      <div><span>SPEED</span><strong>${latestFc.speed.toFixed(2)}<small> m/s</small></strong></div>
      <div><span>DISTANCE</span><strong>${latestFc.value.toFixed(1)}<small> m</small></strong></div>
    `;
  } else {
    elements.fcSummary.hidden = true;
  }

  elements.metrics.innerHTML = paddlers.map((paddler, index) => {
    const cue = guidance.get(paddler.id);
    return `<article style="--color:${colors[index % colors.length]}">
      <div><i></i><span>${paddler.name}</span></div>
      <b class="pace-cue ${cue.className}">${cue.action}</b>
    </article>`;
  }).join("") || `<p class="mobile-empty">Waiting for paddles…</p>`;
}

function mockData(elapsed) {
  const pads = Array.from({ length: config.paddles }, (_, i) => {
    const phase = i * 0.4, scale = 1 + Math.sin(i * 1.7) * 0.15;
    const noise = () => (Math.random() - 0.5) * 0.1;
    return { paddler_id: i + 1, device_id: i + 1, device_name: `MOCK-PADDLER-${i + 1}`, device_ms: elapsed * 1000,
      accel_g: { x: scale * .3 * Math.sin(elapsed * 2.1 + phase) + noise(), y: scale * .2 * Math.sin(elapsed * 1.4 + .8 + phase) + noise(), z: 1 + scale * .12 * Math.sin(elapsed * 2.8 + 1.5 + phase) + noise() },
      gyro_dps: { x: 55 * Math.sin(elapsed * 2.1 + phase), y: 24 * Math.sin(elapsed * 2.1 + phase + .7), z: 18 * Math.sin(elapsed * 2.1 + phase + 1.2) } };
  });
  const fc = [{ mavpackettype: "GLOBAL_POSITION_INT", time_boot_ms: elapsed * 1000, vx: 170 + 45 * Math.sin(elapsed * .8), vy: 35 * Math.sin(elapsed * .55 + .6), vz: 12 * Math.sin(elapsed * .4) }];
  return { pads, fc };
}

function averageAnalysis(key) {
  return state.analysisCounts[key]
    ? state.analysisTotals[key] / state.analysisCounts[key]
    : null;
}

function buildReportSummary() {
  const paddlers = [...state.paddlers.values()];
  const troughSeries = troughTimestampSeries(paddlers);
  const timestampMatch = troughTimestampMatch(troughSeries);
  const guidance = paceGuidance(paddlers, timestampMatch.pairs);
  const latestFc = state.fc.at(-1);
  return {
    report_scope: "Current browser telemetry session. Long-run aggregates cover all received samples; detailed stroke statistics cover the retained analysis window.",
    run_started_at: state.startedWallClock,
    generated_at: new Date().toISOString(),
    run_duration_seconds: (performance.now() - state.startedAt) / 1000,
    scoring_method: {
      overall_weights: { timing: 0.4, waveform_shape_dtw: 0.4, intensity: 0.2 },
      trough_match_tolerance_seconds: config.troughMatchTolerance,
      pace_deadband_ms: config.paceDeadbandMs,
      missing_strokes_score_zero: true,
    },
    average_scores_percent: {
      overall: averageAnalysis("overall"),
      timing: averageAnalysis("timing"),
      waveform_shape: averageAnalysis("shape"),
      intensity: averageAnalysis("intensity"),
    },
    latest_scores_percent: state.latestAnalysis ? {
      overall: state.latestAnalysis.overall,
      timing: state.latestAnalysis.timing,
      waveform_shape: state.latestAnalysis.shape,
      intensity: state.latestAnalysis.intensity,
    } : null,
    timing_pair_coverage: timestampMatch.pairs.map((pair) => ({
      paddlers: pair.names,
      score_percent: pair.score,
      matched_strokes: pair.matches.length,
      expected_strokes: pair.expectedMatches,
    })),
    paddlers: paddlers.map((paddler) => {
      const found = troughs(paddler.points);
      const periods = found.slice(1).map((right, index) =>
        paddler.points[right].time - paddler.points[found[index]].time
      );
      return {
        id: paddler.id,
        name: paddler.name,
        total_samples_received: paddler.totalSamples,
        observed_duration_seconds: paddler.firstTime === null ? 0 : paddler.lastTime - paddler.firstTime,
        acceleration_magnitude_g: {
          mean: paddler.totalSamples ? paddler.accelerationSum / paddler.totalSamples : null,
          minimum: Number.isFinite(paddler.accelerationMin) ? paddler.accelerationMin : null,
          maximum: Number.isFinite(paddler.accelerationMax) ? paddler.accelerationMax : null,
        },
        retained_window: {
          samples: paddler.points.length,
          detected_complete_strokes: periods.length,
          average_stroke_period_seconds: periods.length ? periods.reduce((a, b) => a + b, 0) / periods.length : null,
        },
        current_pace_guidance: guidance.get(paddler.id),
      };
    }),
    flight_controller: latestFc ? {
      latest_speed_mps: latestFc.speed,
      cumulative_distance_m: latestFc.value,
    } : null,
  };
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [payload];
}

async function getPadQueue(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const payload = await response.json();
  if (payload && !Array.isArray(payload) && Array.isArray(payload.events)) {
    return payload.events;
  }
  // Retain compatibility with the earlier bare event/list response.
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && payload.paddler_id != null) return [payload];
  throw new Error("Pad endpoint must return { count, events } with an events array");
}

async function getPadEvents() {
  const results = await Promise.allSettled(config.padUrls.map((url) => getPadQueue(url)));
  const events = [];
  const errors = [];
  let successfulEndpoints = 0;

  results.forEach((result, endpointIndex) => {
    if (result.status === "rejected") {
      errors.push(`Paddle ${endpointIndex + 1}: ${result.reason.message}`);
      return;
    }
    successfulEndpoints += 1;
    result.value.forEach((event) => events.push(event));
  });

  if (!successfulEndpoints && errors.length) throw new Error(errors.join(" · "));
  return { events, errors };
}

function synchronizeClocks() {
  const now = Date.now();
  if (config.mock || now - state.lastClockSync < config.clockSyncMs) return;
  state.lastClockSync = now;
  const body = JSON.stringify({ command: "synchronize_clock", rpi_time_ms: now });
  config.clockSyncUrls.forEach((url) => {
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  });
}

async function poll() {
  if (state.fetching) return;
  state.fetching = true;
  try {
    synchronizeClocks();
    if (config.mock) {
      const data = mockData((performance.now() - state.startedAt) / 1000); addPadEvents(data.pads); addFcMessages(data.fc);
    } else {
      const [padResult, fc] = await Promise.all([
        config.padUrls.length ? getPadEvents() : { events: [], errors: [] },
        config.fcUrl ? getJson(config.fcUrl) : [],
      ]);
      addPadEvents(padResult.events); addFcMessages(fc);
      elements.error.textContent = padResult.errors.join(" · ");
    }
    if (elements.dot) elements.dot.className = "online";
    if (elements.connection) elements.connection.textContent = config.mock ? "Mock data" : "Live";
    if (config.mock) elements.error.textContent = "";
    render();
  } catch (error) {
    if (elements.dot) elements.dot.className = "error-dot";
    if (elements.connection) elements.connection.textContent = "Disconnected";
    elements.error.textContent = error.message;
  } finally {
    state.fetching = false;
    if (state.running) {
      // Endpoint requests naturally limit the rate; mock mode yields one frame so
      // it cannot lock up the browser's main thread.
      state.timer = config.mock
        ? requestAnimationFrame(poll)
        : setTimeout(poll, 0);
    }
  }
}

let reportPageSummary = null;
let reportPageAnalysis = "";
const reportConversation = [];
let reportChatBusy = false;

async function responseJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || response.statusText || "Request failed");
  return payload;
}

async function readTextStream(response, onChunk) {
  if (!response.ok) {
    const payload = await response.json().catch(async () => ({ error: await response.text() }));
    throw new Error(payload.error || response.statusText || "Request failed");
  }
  if (!response.body) throw new Error("Streaming response body is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let complete = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    complete += text;
    onChunk(text, complete);
  }
  const finalText = decoder.decode();
  if (finalText) { complete += finalText; onChunk(finalText, complete); }
  return complete.trim();
}

function appendReportMessage(role, content) {
  const empty = elements.reportMessages.querySelector("p");
  if (empty && !empty.classList.contains("chat-message")) empty.remove();
  const message = document.createElement("p");
  message.className = `chat-message ${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "YOU" : "ANALYST";
  const text = document.createTextNode(content);
  message.append(label, text);
  elements.reportMessages.append(message);
  elements.reportMessages.scrollTop = elements.reportMessages.scrollHeight;
  return text;
}

async function initializeReportPage() {
  if (!isReportView) return;
  try {
    const stored = sessionStorage.getItem("paddleline-report-summary");
    if (!stored) throw new Error("No run summary found. Return to the crew page and generate a report first.");
    reportPageSummary = JSON.parse(stored);
    reportPageAnalysis = sessionStorage.getItem("paddleline-report-analysis") || "";
    if (!reportPageAnalysis) {
      const result = await responseJson(await fetch("/api/report/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: reportPageSummary }),
      }));
      reportPageAnalysis = result.analysis;
      sessionStorage.setItem("paddleline-report-analysis", reportPageAnalysis);
    }
    elements.reportPageStatus.textContent = "Analysis complete";
    elements.downloadReport.disabled = false;
    elements.reportQuestionForm.querySelector("button").disabled = false;
    elements.reportMessages.innerHTML = "<p>Ask a question about this run.</p>";
    elements.downloadReport.click();
  } catch (error) {
    elements.reportPageStatus.textContent = "Unable to generate report";
    elements.reportMessages.textContent = error.message;
    elements.pdfProgress.hidden = true;
  }
}

elements.pause?.addEventListener("click", () => {
  if (state.running) {
    state.running = false;
    clearTimeout(state.timer);
    if (config.mock) cancelAnimationFrame(state.timer);
    state.timer = null;
    elements.pause.textContent = "Resume stream";
    if (elements.connection) elements.connection.textContent = "Paused";
  } else {
    state.running = true;
    elements.pause.textContent = "Pause stream";
    poll();
  }
});
elements.reportButton?.addEventListener("click", () => {
  if (!state.paddlers.size) {
    elements.reportStatus.textContent = "No run data available yet";
    return;
  }
  sessionStorage.removeItem("paddleline-report-analysis");
  sessionStorage.setItem("paddleline-report-summary", JSON.stringify(buildReportSummary()));
  window.location.assign("/report");
});
elements.downloadReport?.addEventListener("click", async () => {
  elements.downloadReport.disabled = true;
  elements.downloadReport.textContent = "Preparing PDF…";
  elements.reportPageStatus.textContent = "Preparing PDF…";
  elements.pdfProgress.hidden = false;
  elements.pdfProgress.classList.add("indeterminate");
  elements.pdfProgress.style.removeProperty("--progress");
  try {
    const response = await fetch("/api/report/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: reportPageSummary, analysis: reportPageAnalysis }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || "Report generation failed");
    }
    const totalBytes = Number(response.headers.get("Content-Length"));
    const chunks = [];
    let receivedBytes = 0;
    let blob;
    if (response.body) {
      const reader = response.body.getReader();
      elements.pdfProgress.classList.remove("indeterminate");
      elements.pdfProgress.style.setProperty("--progress", "0%");
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        receivedBytes += value.byteLength;
        if (totalBytes > 0) {
          const percent = Math.min(100, receivedBytes / totalBytes * 100);
          elements.pdfProgress.style.setProperty("--progress", `${percent}%`);
          elements.downloadReport.textContent = `Downloading ${Math.round(percent)}%`;
        }
      }
      blob = new Blob(chunks, { type: response.headers.get("Content-Type") || "application/pdf" });
    } else {
      blob = await response.blob();
    }
    elements.pdfProgress.classList.remove("indeterminate");
    elements.pdfProgress.style.setProperty("--progress", "100%");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `paddle-report-${new Date().toISOString().replaceAll(":", "-")}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    elements.reportPageStatus.textContent = "PDF downloaded";
  } catch (error) {
    elements.reportPageStatus.textContent = error.message;
  } finally {
    elements.downloadReport.disabled = false;
    elements.downloadReport.textContent = "Download PDF";
    window.setTimeout(() => {
      elements.pdfProgress.hidden = true;
      elements.pdfProgress.classList.add("indeterminate");
      elements.pdfProgress.style.removeProperty("--progress");
    }, 600);
  }
});
elements.reportQuestionForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = elements.reportQuestion.value.trim();
  if (!question || !reportPageAnalysis || reportChatBusy) return;
  reportChatBusy = true;
  appendReportMessage("user", question);
  elements.reportQuestion.value = "";
  elements.reportQuestionForm.querySelector("button").disabled = true;
  try {
    const answerText = appendReportMessage("assistant", "");
    let streamedAnswer = "";
    const answer = await readTextStream(await fetch("/api/report/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: reportPageSummary,
        analysis: reportPageAnalysis,
        question,
        history: reportConversation,
      }),
    }), (_chunk, complete) => {
      streamedAnswer = complete;
      answerText.textContent = complete;
      elements.reportMessages.scrollTop = elements.reportMessages.scrollHeight;
    });
    reportConversation.push(
      { role: "user", content: question },
      { role: "assistant", content: answer || streamedAnswer },
    );
  } catch (error) {
    appendReportMessage("assistant", `Unable to answer: ${error.message}`);
  } finally {
    reportChatBusy = false;
    elements.reportQuestionForm.querySelector("button").disabled = false;
    elements.reportQuestion.focus();
  }
});
if (isReportView) {
  initializeReportPage();
} else {
  window.addEventListener("resize", render);
  initializeVisual();
  poll();
}
