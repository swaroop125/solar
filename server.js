/*
 * ============================================================
 *  Relay Dashboard Server — Node.js / Express
 *  Deploy on Render (render.com) as a Web Service
 *  Dashboard HTML lives in public/index.html
 * ============================================================
 */

const express = require("express");
const path    = require("path");
const app     = express();
const PORT    = process.env.PORT || 3000;

// Optional token auth — set RELAY_TOKEN env var on Render
const AUTH_TOKEN = process.env.RELAY_TOKEN || "";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve dashboard from public/index.html
app.use(express.static(path.join(__dirname, "public")));

// ── In-memory state ──────────────────────────────────────────
let state = {
  relay:          "off",    // "on" | "off"
  mode:           "auto",   // "auto" | "manual"
  rtcTime:        "Unknown",
  pendingCommand: "none",   // "on" | "off" | "auto" | "none"
  lastSeen:       null,
};

// ── Auth middleware ───────────────────────────────────────────
function checkAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const token = req.headers["x-relay-token"] || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── ESP32 Routes ─────────────────────────────────────────────

// ESP32 posts its current state every ~10 s
app.post("/heartbeat", checkAuth, (req, res) => {
  const { relay, mode, time } = req.body;
  if (relay) state.relay   = relay;
  if (mode)  state.mode    = mode;
  if (time)  state.rtcTime = time;
  state.lastSeen = new Date();
  console.log(`[HB] relay=${state.relay} mode=${state.mode} time=${state.rtcTime}`);
  res.json({ ok: true });
});

// ESP32 polls this for any pending command
app.get("/command", checkAuth, (req, res) => {
  const cmd = state.pendingCommand;
  state.pendingCommand = "none";   // clear after delivery
  res.json({ command: cmd });
});

// ── Dashboard API ─────────────────────────────────────────────

// Polled by dashboard JS every 5 s
app.get("/api/state", (req, res) => {
  res.json({
    ...state,
    lastSeen: state.lastSeen ? state.lastSeen.toISOString() : null,
    onlineSeconds: state.lastSeen
      ? Math.floor((Date.now() - state.lastSeen) / 1000)
      : null,
  });
});

// Dashboard sends a control command
app.post("/api/control", (req, res) => {
  const { action } = req.body;
  if (!["on", "off", "auto"].includes(action)) {
    return res.status(400).json({ error: "action must be on | off | auto" });
  }
  state.pendingCommand = action;
  console.log(`[CMD] Queued: ${action}`);
  res.json({ ok: true, queued: action });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Relay dashboard running on port ${PORT}`);
});
