/*
 * ============================================================
 *  Relay Dashboard Server — Node.js / Express
 *  Render deployment — public/index.html for dashboard
 * ============================================================
 */

const express = require("express");
const path    = require("path");
const app     = express();
const PORT    = process.env.PORT || 3000;

const RELAY_TOKEN = process.env.RELAY_TOKEN || "";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Device auth (ESP32 only) ──────────────────────────────────
function checkDeviceAuth(req, res, next) {
  if (!RELAY_TOKEN) return next();
  const token = req.headers["x-relay-token"] || req.query.token;
  if (token !== RELAY_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Relay state ───────────────────────────────────────────────
let state = {
  relay:          "off",
  mode:           "auto",
  rtcTime:        "Unknown",
  pendingCommand: "none",
  lastSeen:       null,
};

// ── Schedule ──────────────────────────────────────────────────
let schedule = {
  onHour: 9,  onMin: 30,
  offHour: 18, offMin: 0,
};

// ── ESP32 routes ──────────────────────────────────────────────
app.post("/heartbeat", checkDeviceAuth, (req, res) => {
  const { relay, mode, time } = req.body;
  if (relay) state.relay   = relay;
  if (mode)  state.mode    = mode;
  if (time)  state.rtcTime = time;
  state.lastSeen = new Date();
  console.log(`[HB] relay=${state.relay} mode=${state.mode} time=${state.rtcTime}`);
  res.json({ ok: true });
});

app.get("/command", checkDeviceAuth, (req, res) => {
  const cmd = state.pendingCommand;
  state.pendingCommand = "none";
  res.json({ command: cmd });
});

app.get("/schedule", checkDeviceAuth, (req, res) => {
  res.json(schedule);
});

// ── Dashboard API (no auth) ───────────────────────────────────
app.get("/api/state", (req, res) => {
  res.json({
    ...state,
    lastSeen: state.lastSeen ? state.lastSeen.toISOString() : null,
    onlineSeconds: state.lastSeen
      ? Math.floor((Date.now() - state.lastSeen) / 1000) : null,
  });
});

app.post("/api/control", (req, res) => {
  const { action } = req.body;
  if (!["on", "off", "auto"].includes(action))
    return res.status(400).json({ error: "action must be on | off | auto" });
  state.pendingCommand = action;
  console.log(`[CMD] Queued: ${action}`);
  res.json({ ok: true, queued: action });
});

app.get("/api/schedule", (req, res) => {
  res.json(schedule);
});

app.post("/api/schedule", (req, res) => {
  const { onHour, onMin, offHour, offMin } = req.body;
  const vals = [onHour, onMin, offHour, offMin].map(Number);
  if (vals.some(isNaN))
    return res.status(400).json({ error: "Invalid values" });
  if (vals[0] < 0 || vals[0] > 23 || vals[2] < 0 || vals[2] > 23)
    return res.status(400).json({ error: "Hours must be 0-23" });
  if (vals[1] < 0 || vals[1] > 59 || vals[3] < 0 || vals[3] > 59)
    return res.status(400).json({ error: "Minutes must be 0-59" });

  schedule = { onHour: vals[0], onMin: vals[1], offHour: vals[2], offMin: vals[3] };
  console.log(`[SCHEDULE] Updated: ON ${vals[0]}:${String(vals[1]).padStart(2,'0')}  OFF ${vals[2]}:${String(vals[3]).padStart(2,'0')}`);
  res.json({ ok: true, schedule });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Relay dashboard running on port ${PORT}`);
});
