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
const reportSystemPrompt = "You are an expert rowing and paddling performance analyst. Write only the body copy for a report, at most 400 words. Do not write a title, header, footer, preamble, Markdown, bullets, tables, hashes, asterisks, or decorative separators. Use short plain-text section labels followed by compact paragraphs covering overview, timing, stroke consistency, and limitations. Finish with three lines labelled Action 1:, Action 2:, and Action 3:. Cite supplied measurements, distinguish inference from fact, and never invent data.";

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
    document.font("Helvetica").fontSize(11).fillColor("#10111a")
      .text(analysis, { lineGap: 4, align: "left" });

    const pages = document.bufferedPageRange();
    for (let pageIndex = pages.start; pageIndex < pages.start + pages.count; pageIndex += 1) {
      document.switchToPage(pageIndex);
      const pageWidth = document.page.width;
      const pageHeight = document.page.height;
      document.font("Helvetica-Bold").fontSize(15).fillColor("#1455ff")
        .text("PADDLELINE / RUN ANALYSIS", 54, 32, { width: pageWidth - 108, lineBreak: false });
      document.font("Helvetica").fontSize(8).fillColor("#50638f")
        .text(`Generated ${generatedLabel}  ·  Run ${summary.run_duration_seconds?.toFixed?.(1) ?? "—"} s`, 54, 54, { width: pageWidth - 108, lineBreak: false });
      document.strokeColor("#1455ff").lineWidth(1).moveTo(54, 70).lineTo(pageWidth - 54, 70).stroke();
      document.strokeColor("#1455ff").lineWidth(0.7).moveTo(54, pageHeight - 48).lineTo(pageWidth - 54, pageHeight - 48).stroke();
      document.font("Helvetica").fontSize(7).fillColor("#50638f")
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

async function fetchConfiguredJson(variable) {
  const endpoint = process.env[variable];
  if (!endpoint) throw new Error(`${variable} is not configured`);
  const upstream = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(Number(process.env.TELEMETRY_TIMEOUT_MS || 5000)),
  });
  if (!upstream.ok) throw new Error(`${variable} returned HTTP ${upstream.status}`);
  return upstream.json();
}

function wrapDegrees(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function normalizeBoat(payload) {
  if (payload && !Array.isArray(payload) && Number.isFinite(Number(payload.speed_kmh))) return payload;
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
  const events = Array.isArray(payload) ? payload : payload?.events || (payload ? [payload] : []);
  for (const event of events) {
    const id = String(event.paddler_id ?? event.paddle_id ?? "1");
    const sampleTime = Number(event.device_ms ?? event.timestamp_unix_ms ?? Date.now());
    const magnitude = accelMagnitude(event);
    const current = thuzhayanState.paddlers.get(id) || { id, samples: [], troughs: [], spm: 0 };
    current.samples.push({ time: sampleTime, value: magnitude });
    if (current.samples.length > 40) current.samples.shift();
    const last = current.samples.length - 2;
    if (last > 0 && current.samples[last].value < current.samples[last - 1].value && current.samples[last].value <= current.samples[last + 1].value) {
      const troughTime = current.samples[last].time;
      if (!current.troughs.length || troughTime - current.troughs.at(-1) >= 600) current.troughs.push(troughTime);
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
  const [first, second = first] = paddlers;
  const spmDelta = Math.abs(first.spm - second.spm);
  const sync = paddlers.length < 2 ? 100 : Math.max(0, 100 - spmDelta * 12);
  const result = {
    timestamp_unix_ms: Date.now(), event: "dual_paddle_telemetry",
    stroke_rate_spm: (first.spm + second.spm) / 2,
    peak_accel_g: Math.max(first.accel_g, second.accel_g),
    sync_percentage: sync, spm_delta: spmDelta, side_switch_active: false,
    paddler_1: first, paddler_2: second,
  };
  thuzhayanState.paddle = result;
  return result;
}

app.get(["/thuzhayan", "/thuzhayan/"], (_request, response) => {
  response.sendFile("thuzhayan.html", { root: process.cwd() });
});

app.get("/api/latest", async (_request, response) => {
  try { response.json(normalizeBoat(await fetchConfiguredJson("FC_ENDPOINT_URL"))); }
  catch { response.json(thuzhayanState.boat || { state: "waiting" }); }
});

app.get("/api/paddle/latest", async (_request, response) => {
  try { response.json(normalizePaddles(await fetchConfiguredJson("ACCELEROMETER_ENDPOINT_URL"))); }
  catch { response.json(thuzhayanState.paddle || { state: "waiting" }); }
});

app.get("/api/overall", (_request, response) => {
  const boat = thuzhayanState.boat;
  const paddle = thuzhayanState.paddle;
  response.json({ report: boat ? [
    "OVERALL BOAT TELEMETRY REPORT", "===============================",
    `Speed: ${Number(boat.speed_kmh || 0).toFixed(2)} km/h`,
    `Heading drift: ${boat.drift_deg == null ? "—" : `${Number(boat.drift_deg).toFixed(1)}°`}`,
    `Yaw stability: ${Number(boat.yaw_stability_10s_dps || 0).toFixed(2)}°/s`,
    `Crew sync: ${paddle ? `${Number(paddle.sync_percentage).toFixed(1)}%` : "—"}`,
  ].join("\n") : "Waiting for the first telemetry record." });
});

app.get("/api/gemma/advice", (_request, response) => {
  const boat = thuzhayanState.boat;
  const paddle = thuzhayanState.paddle;
  let advice = "Waiting for active telemetry hardware data...";
  if (boat) {
    if (boat.gpio_alert_active) advice = "HIGH HULL MOTION: Equalize port and starboard pressure and avoid abrupt steering input.";
    else if (paddle && paddle.sync_percentage < 80) advice = "CREW SYNCHRONIZATION: Follow one lead cadence and align blade entry timing.";
    else advice = "NORMAL HYDRODYNAMICS: Maintain the current rhythm, trim, and pressure balance.";
  }
  response.json({ status: boat ? "active" : "waiting", engine: "edge_heuristics", gemma_model: ollamaModel, advice });
});

app.get("/api/gemini/report", async (_request, response) => {
  try {
    const analysis = await ollamaGenerate(
      `Analyze this boat and paddle telemetry:\n${JSON.stringify({ boat: thuzhayanState.boat, paddle: thuzhayanState.paddle })}`,
      "Give a concise hydrodynamic performance analysis with practical coaching recommendations. Do not invent unavailable measurements.",
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
