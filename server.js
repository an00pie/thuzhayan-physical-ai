import "dotenv/config";

import express from "express";
import PDFDocument from "pdfkit";

const app = express();
const port = Number(process.env.PORT || 5173);
const production = process.env.NODE_ENV === "production";

app.use(express.json({ limit: "1mb" }));

const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || "http://100.126.17.82:11434").replace(/\/+$/, "");
const ollamaModel = process.env.OLLAMA_MODEL || "gemma3-local:latest";
const ollamaKeepAlive = process.env.OLLAMA_KEEP_ALIVE || "30m";
const reportMaxTokens = Number(process.env.REPORT_MAX_TOKENS || 550);
const chatMaxTokens = Number(process.env.CHAT_MAX_TOKENS || 400);
const reportSystemPrompt = "Write a short, friendly coaching report for paddlers with no technical background. Use everyday language and briefly explain any unavoidable term. Focus on what happened, why it matters, and what the crew can do next. Include the estimated wave-adjusted thrust proxy when present, clearly explain that it is an estimate based on boat speed and gyro angle, not a direct force measurement. Refer to people only by their supplied ordinal labels, such as 1st Paddle, 2nd Paddle, or 4th Paddle. Never repeat device names, sensor IDs, codenames, IP addresses, or hardware labels. Write only the report body, at most 400 words. Do not write a title, header, footer, preamble, Markdown, bullets, tables, hashes, asterisks, or decorative separators. Use short plain-text section labels followed by compact paragraphs covering the overall run, timing, stroke consistency, thrust estimate, and data limitations. Finish with three simple lines labelled Action 1:, Action 2:, and Action 3:. Use supplied measurements when useful, clearly separate facts from educated guesses, and never invent data.";

async function ollamaGenerate(prompt, system, maxTokens = 1400) {
  const ollamaResponse = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      system,
      prompt,
      stream: false,
      keep_alive: ollamaKeepAlive,
      options: { temperature: 0.2, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS || 180000)),
  });
  const body = await ollamaResponse.json().catch(() => ({}));
  if (!ollamaResponse.ok) {
    throw new Error(body.error || `Ollama returned HTTP ${ollamaResponse.status}`);
  }
  if (typeof body.response !== "string") throw new Error("Ollama returned no generated text.");
  return body.response.trim();
}

async function streamOllama(prompt, system, maxTokens, response) {
  const ollamaResponse = await fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      system,
      prompt,
      stream: true,
      keep_alive: ollamaKeepAlive,
      options: { temperature: 0.2, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS || 180000)),
  });
  if (!ollamaResponse.ok) {
    const body = await ollamaResponse.json().catch(() => ({}));
    throw new Error(body.error || `Ollama returned HTTP ${ollamaResponse.status}`);
  }
  response.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of ollamaResponse.body) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.response) response.write(event.response);
      if (event.error) throw new Error(event.error);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    const event = JSON.parse(pending);
    if (event.response) response.write(event.response);
  }
  response.end();
}

async function generateAnalysis(summary) {
  return ollamaGenerate(
    `Analyze this synchronized paddle-run telemetry summary:\n${JSON.stringify(summary)}`,
    reportSystemPrompt,
    reportMaxTokens,
  );
}

function createPdf(analysis, summary) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", margins: { top: 92, right: 54, bottom: 68, left: 54 }, bufferPages: true, info: {
      Title: "Paddle Stroke Analysis Report",
      Author: "Paddleline",
    } });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    const generatedLabel = new Date().toLocaleString();
    document.font("Helvetica").fontSize(11).fillColor("#080808")
      .text(analysis, { lineGap: 4, align: "left" });

    const pages = document.bufferedPageRange();
    for (let pageIndex = pages.start; pageIndex < pages.start + pages.count; pageIndex += 1) {
      document.switchToPage(pageIndex);
      const pageWidth = document.page.width;
      const pageHeight = document.page.height;
      document.font("Helvetica-Bold").fontSize(15).fillColor("#e54616")
        .text("PADDLELINE / RUN ANALYSIS", 54, 32, { width: pageWidth - 108, lineBreak: false });
      document.font("Helvetica").fontSize(8).fillColor("#242424")
        .text(`Generated ${generatedLabel}  ·  Run ${summary.run_duration_seconds?.toFixed?.(1) ?? "—"} s`, 54, 54, { width: pageWidth - 108, lineBreak: false });
      document.strokeColor("#e54616").lineWidth(1).moveTo(54, 70).lineTo(pageWidth - 54, 70).stroke();
      document.strokeColor("#e54616").lineWidth(0.7).moveTo(54, pageHeight - 48).lineTo(pageWidth - 54, pageHeight - 48).stroke();
      document.font("Helvetica").fontSize(7).fillColor("#242424")
        .text("Generated from synchronized telemetry · Coaching aid, not a safety instrument", 54, pageHeight - 38, { width: pageWidth - 150, lineBreak: false })
        .text(`${pageIndex - pages.start + 1} / ${pages.count}`, pageWidth - 110, pageHeight - 38, { width: 56, align: "right", lineBreak: false });
    }
    document.end();
  });
}

app.post("/api/report", async (request, response) => {
  const summary = request.body;
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.paddlers)) {
    response.status(400).json({ error: "A valid run summary is required." });
    return;
  }

  try {
    const analysis = await generateAnalysis(summary);
    const pdf = await createPdf(analysis, summary);
    const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
    response.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="paddle-report-${timestamp}.pdf"`,
      "Content-Length": String(pdf.length),
    });
    response.send(pdf);
  } catch (error) {
    console.error("Report generation failed:", error);
    response.status(500).json({ error: error?.message || "Report generation failed." });
  }
});

app.post("/api/report/analyze", async (request, response) => {
  const summary = request.body?.summary;
  if (!summary || !Array.isArray(summary.paddlers)) {
    response.status(400).json({ error: "A valid run summary is required." });
    return;
  }
  try {
    const analysis = await ollamaGenerate(
      `Analyze this synchronized paddle-run telemetry summary:\n${JSON.stringify(summary)}`,
      reportSystemPrompt,
      reportMaxTokens,
    );
    response.json({ analysis });
  } catch (error) {
    response.status(502).json({ error: error?.message || "Ollama report analysis failed." });
  }
});

app.post("/api/report/pdf", async (request, response) => {
  const { summary, analysis } = request.body || {};
  if (!summary || !Array.isArray(summary.paddlers) || typeof analysis !== "string") {
    response.status(400).json({ error: "A valid report and run summary are required." });
    return;
  }
  try {
    const pdf = await createPdf(analysis, summary);
    const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
    response.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="paddle-report-${timestamp}.pdf"`,
      "Content-Length": String(pdf.length),
    });
    response.send(pdf);
  } catch (error) {
    response.status(500).json({ error: error?.message || "PDF generation failed." });
  }
});

app.post("/api/report/chat", async (request, response) => {
  const { summary, analysis, question, history = [] } = request.body || {};
  if (!summary || !Array.isArray(summary.paddlers) || typeof analysis !== "string" || typeof question !== "string" || !question.trim()) {
    response.status(400).json({ error: "A report and question are required." });
    return;
  }
  try {
    const safeHistory = Array.isArray(history) ? history.slice(-8).filter(
      (message) => ["user", "assistant"].includes(message?.role) && typeof message?.content === "string"
    ) : [];
    const conversation = safeHistory.map(
      (message) => `${message.role === "user" ? "USER" : "ANALYST"}: ${message.content}`
    ).join("\n");
    await streamOllama(
      `RUN TELEMETRY SUMMARY:\n${JSON.stringify(summary)}\n\nGENERATED REPORT:\n${analysis}\n\nRECENT CONVERSATION:\n${conversation || "None"}\n\nUSER QUESTION:\n${question.trim()}`,
      "Answer only from the supplied paddle-run telemetry and generated report. Be concise, distinguish measurements from inference, and say when the report cannot answer something.",
      chatMaxTokens,
      response,
    );
  } catch (error) {
    if (response.headersSent) response.end(`\n\nGeneration error: ${error.message}`);
    else response.status(502).json({ error: error?.message || "Question answering failed." });
  }
});

// The original THUZHAYAN dashboard is intentionally kept as a self-contained
// page. These routes adapt this server's configured telemetry sources to the
// API contract expected by that page without touching the Paddleline frontend.
const thuzhayanState = { boat: null, paddle: null, paddlers: new Map(), yaw: [] };
const physicalAiMock = String(process.env.VITE_USE_MOCK_DATA || "false").toLowerCase() === "true";

function mockPhysicalAiBoat() {
  const elapsed = Date.now() / 1000;
  const speedKmh = 8.4 + Math.sin(elapsed * 0.31) * 1.15 + Math.sin(elapsed * 0.09) * 0.45;
  const heading = 84 + Math.sin(elapsed * 0.08) * 3;
  const course = heading + Math.sin(elapsed * 0.17) * 4.2;
  const boat = {
    timestamp_unix_ms: Date.now(), source: "physical_ai_mock",
    speed_mps: speedKmh / 3.6, speed_kmh: speedKmh,
    course_deg: course, heading_deg: heading, drift_deg: wrapDegrees(course - heading),
    roll_deg: Math.sin(elapsed * 0.73) * 2.4,
    pitch_deg: Math.sin(elapsed * 0.47 + 0.8) * 1.3,
    yaw_rate_dps: Math.sin(elapsed * 1.1) * 1.8,
    yaw_stability_10s_dps: 1.1 + Math.abs(Math.sin(elapsed * 0.23)) * 0.8,
    gps_fix: 3, gps_satellites: 12, gps_healthy: true,
    battery_v: 12.4 - ((elapsed / 600) % 0.5), gpio_alert_active: false,
  };
  thuzhayanState.boat = boat;
  return boat;
}

function mockPhysicalAiPaddles() {
  const elapsed = Date.now() / 1000;
  const firstSpm = 31.5 + Math.sin(elapsed * 0.19) * 1.8;
  const secondSpm = 30.7 + Math.sin(elapsed * 0.19 + 0.55) * 2.1;
  const firstAccel = 1.52 + Math.sin(elapsed * firstSpm / 60 * Math.PI * 2) * 0.28;
  const secondAccel = 1.46 + Math.sin(elapsed * secondSpm / 60 * Math.PI * 2 + 0.48) * 0.31;
  const spmDelta = Math.abs(firstSpm - secondSpm);
  const paddle = {
    timestamp_unix_ms: Date.now(), event: "dual_paddle_telemetry", source: "physical_ai_mock",
    stroke_rate_spm: (firstSpm + secondSpm) / 2,
    peak_accel_g: Math.max(firstAccel, secondAccel),
    sync_percentage: Math.max(45, 100 - spmDelta * 8.5), spm_delta: spmDelta,
    side_switch_active: false,
    paddler_1: { paddle_id: 1, device_name: "PADDLER-1", spm: firstSpm, accel_g: firstAccel, side: "STARBOARD", side_switch_event: false, status: "simulated" },
    paddler_2: { paddle_id: 2, device_name: "PADDLER-2", spm: secondSpm, accel_g: secondAccel, side: "PORT", side_switch_event: false, status: "simulated" },
  };
  thuzhayanState.paddle = paddle;
  return paddle;
}

async function fetchConfiguredJson(variable) {
  const endpoint = process.env[variable];
  if (!endpoint) throw new Error(`${variable} is not configured`);
  const timeoutVariable = variable === "ACCELEROMETER_ENDPOINT_URL"
    ? "ACCELEROMETER_REQUEST_TIMEOUT_MS"
    : "TELEMETRY_TIMEOUT_MS";
  const timeoutMs = Number(process.env[timeoutVariable] || (variable === "ACCELEROMETER_ENDPOINT_URL" ? 60000 : 5000));
  const upstream = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!upstream.ok) throw new Error(`${variable} returned HTTP ${upstream.status}`);
  return upstream.json();
}

async function proxyConfiguredJson(variable, response) {
  try {
    response.json(await fetchConfiguredJson(variable));
  } catch (error) {
    response.status(502).json({
      error: error?.message || `${variable} could not be reached`,
    });
  }
}

// Keep telemetry URLs server-side. These explicit routes work in both the Vite
// development server and the production Express server, and always use the
// current values from .env.
app.get("/api/pad", (_request, response) => proxyConfiguredJson("ACCELEROMETER_ENDPOINT_URL", response));
app.get("/api/fc", (_request, response) => proxyConfiguredJson("FC_ENDPOINT_URL", response));

function wrapDegrees(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function normalizeBoat(payload) {
  if (payload && !Array.isArray(payload) && Number.isFinite(Number(payload.speed_kmh))) return payload;
  if (payload && !Array.isArray(payload) && Array.isArray(payload.data)) {
    for (const record of payload.data) normalizeBoat(record);
    return thuzhayanState.boat || { state: "waiting" };
  }
  if (payload && !Array.isArray(payload) && (payload.imu || payload.gps || payload.battery)) {
    const previous = thuzhayanState.boat || {};
    const speedMps = Number(payload.gps?.speed_m_s);
    const heading = Number(payload.compass_heading_deg ?? payload.gps?.heading_deg ?? payload.imu?.yaw ?? payload.imu?.orientation_deg?.yaw);
    const yawRate = Number(payload.imu?.gyro_z ?? payload.imu?.gyro_dps?.z);
    const now = Date.now();
    if (Number.isFinite(yawRate)) {
      thuzhayanState.yaw.push({ now, value: yawRate });
      thuzhayanState.yaw = thuzhayanState.yaw.filter((sample) => now - sample.now <= 10000);
    }
    const yawMean = thuzhayanState.yaw.reduce((sum, sample) => sum + sample.value, 0) / Math.max(1, thuzhayanState.yaw.length);
    const yawStability = Math.sqrt(thuzhayanState.yaw.reduce(
      (sum, sample) => sum + (sample.value - yawMean) ** 2,
      0,
    ) / Math.max(1, thuzhayanState.yaw.length));
    const boat = {
      ...previous,
      timestamp_unix_ms: Number(payload.timestamp_ms) || now,
      status: payload.status,
      flight_mode: payload.flight_mode,
      armed: Boolean(payload.armed),
      speed_mps: Number.isFinite(speedMps) ? speedMps : previous.speed_mps,
      speed_kmh: Number.isFinite(speedMps) ? speedMps * 3.6 : previous.speed_kmh,
      course_deg: Number.isFinite(heading) ? heading : previous.course_deg,
      heading_deg: Number.isFinite(heading) ? heading : previous.heading_deg,
      drift_deg: 0,
      roll_deg: Number(payload.imu?.roll ?? payload.imu?.orientation_deg?.roll) || 0,
      pitch_deg: Number(payload.imu?.pitch ?? payload.imu?.orientation_deg?.pitch) || 0,
      yaw_rate_dps: Number.isFinite(yawRate) ? yawRate : 0,
      yaw_stability_10s_dps: yawStability,
      gps_fix: Number(payload.gps?.fix_type) || 0,
      gps_satellites: Number(payload.gps?.satellites) || 0,
      gps_healthy: Number(payload.gps?.fix_type) >= 3,
      latitude: Number(payload.gps?.lat),
      longitude: Number(payload.gps?.lon),
      altitude_m: Number(payload.gps?.alt_m),
      battery_v: Number(payload.battery?.voltage_v),
      battery_current_a: Number(payload.battery?.current_a),
      battery_percentage: Number(payload.battery?.percentage),
    };
    boat.gpio_alert_active = yawStability > 5 || Math.abs(boat.roll_deg) > 15;
    thuzhayanState.boat = boat;
    return boat;
  }
  const messages = Array.isArray(payload) ? payload : payload?.events || [payload];
  const previous = thuzhayanState.boat || {};
  const boat = { ...previous, timestamp_unix_ms: Date.now() };
  for (const message of messages.filter(Boolean)) {
    const kind = message.mavpackettype;
    if (kind === "GLOBAL_POSITION_INT") {
      const vx = Number(message.vx) / 100, vy = Number(message.vy) / 100;
      boat.speed_mps = Math.hypot(vx, vy, Number(message.vz) / 100);
      boat.speed_kmh = boat.speed_mps * 3.6;
      if (Math.hypot(vx, vy) > 0.2) boat.course_deg = (Math.atan2(vy, vx) * 180 / Math.PI + 360) % 360;
      if (Number.isFinite(Number(message.hdg)) && Number(message.hdg) !== 65535) boat.heading_deg = Number(message.hdg) / 100;
    } else if (kind === "ATTITUDE") {
      boat.roll_deg = Number(message.roll) * 180 / Math.PI;
      boat.pitch_deg = Number(message.pitch) * 180 / Math.PI;
      boat.yaw_rate_dps = Number(message.yawspeed) * 180 / Math.PI;
      const now = Date.now();
      thuzhayanState.yaw.push({ now, value: boat.yaw_rate_dps });
      thuzhayanState.yaw = thuzhayanState.yaw.filter((sample) => now - sample.now <= 10000);
      const mean = thuzhayanState.yaw.reduce((sum, sample) => sum + sample.value, 0) / Math.max(1, thuzhayanState.yaw.length);
      boat.yaw_stability_10s_dps = Math.sqrt(thuzhayanState.yaw.reduce((sum, sample) => sum + (sample.value - mean) ** 2, 0) / Math.max(1, thuzhayanState.yaw.length));
    } else if (kind === "GPS_RAW_INT") {
      boat.gps_fix = Number(message.fix_type);
      boat.gps_satellites = Number(message.satellites_visible);
      boat.gps_healthy = boat.gps_fix >= 3;
    } else if (kind === "SYS_STATUS") {
      const millivolts = Number(message.voltage_battery);
      if (millivolts !== 65535) boat.battery_v = millivolts / 1000;
    }
  }
  if (boat.course_deg != null && boat.heading_deg != null) boat.drift_deg = wrapDegrees(boat.course_deg - boat.heading_deg);
  boat.gpio_alert_active = (boat.yaw_stability_10s_dps || 0) > 5 || Math.abs(boat.roll_deg || 0) > 15;
  thuzhayanState.boat = boat;
  return boat;
}

function accelMagnitude(event) {
  if (Number.isFinite(Number(event.accel_magnitude_g))) return Number(event.accel_magnitude_g);
  if (Number.isFinite(Number(event.peak_accel_g))) return Number(event.peak_accel_g);
  const vector = event.accel_g;
  if (vector && typeof vector === "object") return Math.hypot(Number(vector.x) || 0, Number(vector.y) || 0, Number(vector.z) || 0);
  return Number(vector) || 1;
}

function normalizePaddles(payload) {
  if (payload?.paddler_1 && payload?.paddler_2) return payload;
  const events = Array.isArray(payload) ? payload : payload?.data || payload?.events || (payload ? [payload] : []);
  const now = Date.now();
  const idleTimeoutMs = Number(process.env.PADDLE_IDLE_TIMEOUT_MS || 3500);
  for (const event of events) {
    const id = String(event.paddler_id ?? event.paddle_id ?? event.device_id ?? "1");
    const sampleTime = Number(event.device_ms ?? event.timestamp_unix_ms ?? Date.now());
    const magnitude = accelMagnitude(event);
    const current = thuzhayanState.paddlers.get(id) || { id, samples: [], troughs: [], spm: 0 };
    current.lastSampleReceivedAt = now;
    current.samples.push({ time: sampleTime, value: magnitude });
    if (current.samples.length > 40) current.samples.shift();
    const last = current.samples.length - 2;
    if (last > 0 && current.samples[last].value < current.samples[last - 1].value && current.samples[last].value <= current.samples[last + 1].value) {
      const troughTime = current.samples[last].time;
      if (!current.troughs.length || troughTime - current.troughs.at(-1) >= 600) {
        current.troughs.push(troughTime);
        current.lastStrokeReceivedAt = now;
      }
      if (current.troughs.length > 5) current.troughs.shift();
      if (current.troughs.length > 1) current.spm = 60000 / ((current.troughs.at(-1) - current.troughs[0]) / (current.troughs.length - 1));
    }
    current.accel_g = magnitude;
    current.side = Number(event.orientation_deg?.roll ?? event.roll_deg ?? 0) < 0 ? "PORT" : "STARBOARD";
    current.name = event.device_name || `PADDLER-${id}`;
    thuzhayanState.paddlers.set(id, current);
  }
  const paddlers = [...thuzhayanState.paddlers.values()].slice(0, 2);
  if (!paddlers.length) return thuzhayanState.paddle || { state: "waiting" };
  for (const paddler of paddlers) {
    const lastActivity = paddler.lastStrokeReceivedAt ?? paddler.lastSampleReceivedAt ?? 0;
    if (now - lastActivity > idleTimeoutMs) {
      paddler.spm = 0;
      paddler.accel_g = 1;
    }
  }
  const [first, second = first] = paddlers;
  const spmDelta = Math.abs(first.spm - second.spm);
  const bothIdle = first.spm < 4 && second.spm < 4;
  const accelDelta = Math.abs((first.accel_g ?? 1) - (second.accel_g ?? 1));
  const sync = paddlers.length < 2 || bothIdle
    ? 100
    : Math.max(10, 100 - Math.min(60, spmDelta * 12) - Math.min(40, accelDelta * 18));
  const result = {
    timestamp_unix_ms: Date.now(), event: "dual_paddle_telemetry",
    stroke_rate_spm: bothIdle ? 0 : (first.spm + second.spm) / 2,
    peak_accel_g: Math.max(first.accel_g ?? 1, second.accel_g ?? 1),
    sync_percentage: sync, spm_delta: bothIdle ? 0 : spmDelta, side_switch_active: false,
    paddler_1: first, paddler_2: second,
  };
  thuzhayanState.paddle = result;
  return result;
}

app.get(["/telemetry", "/telemetry/"], (_request, response) => {
  response.sendFile("thuzhayan.html", { root: process.cwd() });
});
app.get(["/physical-ai", "/physical-ai/", "/thuzhayan", "/thuzhayan/"], (_request, response) => response.redirect(308, "/telemetry"));

app.get("/api/telemetry/boat", async (_request, response) => {
  if (physicalAiMock) { response.json(mockPhysicalAiBoat()); return; }
  try { response.json(normalizeBoat(await fetchConfiguredJson("FC_ENDPOINT_URL"))); }
  catch { response.json(thuzhayanState.boat || { state: "waiting" }); }
});

app.get("/api/telemetry/paddles", async (_request, response) => {
  if (physicalAiMock) { response.json(mockPhysicalAiPaddles()); return; }
  try { response.json(normalizePaddles(await fetchConfiguredJson("ACCELEROMETER_ENDPOINT_URL"))); }
  catch { response.json(thuzhayanState.paddle || { state: "waiting" }); }
});

app.get("/api/telemetry/summary", (_request, response) => {
  const boat = physicalAiMock ? mockPhysicalAiBoat() : thuzhayanState.boat;
  const paddle = physicalAiMock ? mockPhysicalAiPaddles() : thuzhayanState.paddle;
  response.json({ report: boat ? [
    "OVERALL BOAT TELEMETRY REPORT", "===============================",
    `Speed: ${Number(boat.speed_kmh || 0).toFixed(2)} km/h`,
    `Heading drift: ${boat.drift_deg == null ? "—" : `${Number(boat.drift_deg).toFixed(1)}°`}`,
    `Yaw stability: ${Number(boat.yaw_stability_10s_dps || 0).toFixed(2)}°/s`,
    `Crew sync: ${paddle ? `${Number(paddle.sync_percentage).toFixed(1)}%` : "—"}`,
  ].join("\n") : "Waiting for the first telemetry record." });
});

app.get("/api/telemetry/advice", (_request, response) => {
  const boat = physicalAiMock ? mockPhysicalAiBoat() : thuzhayanState.boat;
  const paddle = physicalAiMock ? mockPhysicalAiPaddles() : thuzhayanState.paddle;
  let advice = "Waiting for active telemetry hardware data...";
  if (boat) {
    if (boat.gpio_alert_active) advice = "HIGH HULL MOTION: Equalize port and starboard pressure and avoid abrupt steering input.";
    else if (paddle && paddle.sync_percentage < 80) advice = "CREW SYNCHRONIZATION: Follow one lead cadence and align blade entry timing.";
    else advice = "NORMAL HYDRODYNAMICS: Maintain the current rhythm, trim, and pressure balance.";
  }
  response.json({ status: boat ? "active" : "waiting", engine: "edge_heuristics", gemma_model: ollamaModel, advice });
});

app.get("/api/telemetry/analysis", async (_request, response) => {
  if (physicalAiMock) { mockPhysicalAiBoat(); mockPhysicalAiPaddles(); }
  try {
    const paddle = thuzhayanState.paddle;
    const boat = thuzhayanState.boat;
    const readerFriendlyTelemetry = {
      boat: boat ? {
        speed_kmh: boat.speed_kmh, course_deg: boat.course_deg, heading_deg: boat.heading_deg,
        drift_deg: boat.drift_deg, roll_deg: boat.roll_deg, pitch_deg: boat.pitch_deg,
        yaw_stability_10s_dps: boat.yaw_stability_10s_dps,
        gps_healthy: boat.gps_healthy, gps_satellites: boat.gps_satellites,
      } : null,
      crew: paddle ? {
        stroke_rate_spm: paddle.stroke_rate_spm,
        sync_percentage: paddle.sync_percentage,
        cadence_difference_spm: paddle.spm_delta,
        "1st Paddle": { stroke_rate_spm: paddle.paddler_1?.spm, acceleration_g: paddle.paddler_1?.accel_g, side: paddle.paddler_1?.side },
        "2nd Paddle": { stroke_rate_spm: paddle.paddler_2?.spm, acceleration_g: paddle.paddler_2?.accel_g, side: paddle.paddler_2?.side },
      } : null,
    };
    const analysis = await ollamaGenerate(
      `Analyze this boat and paddle telemetry:\n${JSON.stringify(readerFriendlyTelemetry)}`,
      "Explain the run in friendly everyday language for someone without a technical background. Say what happened, why it matters, and what to try next. Refer to people only as 1st Paddle, 2nd Paddle, and so on. Never use device names, sensor IDs, codenames, IP addresses, or hardware labels. Briefly explain any unavoidable technical term and do not invent unavailable measurements.",
      reportMaxTokens,
    );
    response.json({ analysis });
  } catch (error) { response.status(502).json({ analysis: `Analysis unavailable: ${error.message}` }); }
});

if (production) {
  app.use(express.static("dist"));
  app.get("/{*path}", (_request, response) => response.sendFile("index.html", { root: "dist" }));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Paddleline running at http://localhost:${port}`);
  fetch(`${ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: ollamaModel, prompt: "", stream: false, keep_alive: ollamaKeepAlive }),
  }).catch(() => {});
});
