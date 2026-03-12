/*
 * ============================================================
 *  Relay Dashboard Server — Node.js / Express
 *  Server handles ALL scheduling — sends ON/OFF commands
 *  to ESP32 based on time. ESP just follows commands.
 * ============================================================
 */

const express = require("express");
const path    = require("path");
const fs      = require("fs");
const app     = express();
const PORT    = process.env.PORT || 3000;

const RELAY_TOKEN   = process.env.RELAY_TOKEN || "";
const SCHEDULE_FILE = path.join(__dirname, "schedule.json");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Schedule: load from file, fallback to default ─────────────
function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8"));
      console.log(`[SCHEDULE] Loaded: ON ${data.onHour}:${String(data.onMin).padStart(2,'0')}  OFF ${data.offHour}:${String(data.offMin).padStart(2,'0')}`);
      return data;
    }
  } catch (e) {
    console.error("[SCHEDULE] Load failed:", e.message);
  }
  return { onHour: 9, onMin: 30, offHour: 18, offMin: 0 };
}

function saveScheduleToDisk(sched) {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(sched, null, 2));
    console.log(`[SCHEDULE] Saved: ON ${sched.onHour}:${String(sched.onMin).padStart(2,'0')}  OFF ${sched.offHour}:${String(sched.offMin).padStart(2,'0')}`);
  } catch (e) {
    console.error("[SCHEDULE] Save failed:", e.message);
  }
}

let schedule = loadSchedule();

// ── Relay state ───────────────────────────────────────────────
let state = {
  relay:          "off",
  mode:           "auto",
  rtcTime:        "Unknown",
  pendingCommand: "none",
  lastSeen:       null,
};

// ── Server-side scheduler ─────────────────────────────────────
// Runs every minute, sends ON/OFF command to ESP based on time
function runScheduler() {
  // Parse RTC time from last heartbeat e.g. "2026-03-08 14:30:00"
  // Fall back to server time if RTC not available
  let h, m;

  if (state.rtcTime && state.rtcTime !== "Unknown") {
    const parts = state.rtcTime.split(" ");
    if (parts.length === 2) {
      const timeParts = parts[1].split(":");
      h = parseInt(timeParts[0]);
      m = parseInt(timeParts[1]);
    }
  }

  // Fallback to server time (UTC+5:30 for India)
  if (h === undefined || isNaN(h)) {
    const now = new Date();
    // Adjust to IST (UTC+5:30)
    const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    h = ist.getUTCHours();
    m = ist.getUTCMinutes();
  }

  const cur  = h * 60 + m;
  const onM  = schedule.onHour  * 60 + schedule.onMin;
  const offM = schedule.offHour * 60 + schedule.offMin;

  const shouldBeOn = (cur >= onM && cur < offM);
  const currentState = state.relay === "on";

  if (shouldBeOn !== currentState) {
    state.pendingCommand = shouldBeOn ? "on" : "off";
    console.log(`[SCHEDULER] ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} → queuing ${state.pendingCommand.toUpperCase()} command`);
  }
}

// Run scheduler every minute
setInterval(runScheduler, 60 * 1000);
// Also run immediately on startup
setTimeout(runScheduler, 3000);

// ── Device auth ───────────────────────────────────────────────
function checkDeviceAuth(req, res, next) {
  if (!RELAY_TOKEN) return next();
  const token = req.headers["x-relay-token"] || req.query.token;
  if (token !== RELAY_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

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

// Keep /schedule endpoint so old ESP code still works
app.get("/schedule", checkDeviceAuth, (req, res) => {
  res.json(schedule);
});

// ── Dashboard API ─────────────────────────────────────────────
app.get("/api/state", (req, res) => {
  res.json({
    ...state,
    schedule,
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

// Save schedule + immediately queue correct command based on current time
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
  saveScheduleToDisk(schedule);

  // Immediately apply: queue the correct command right now
  runScheduler();

  res.json({ ok: true, schedule });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Relay dashboard running on port ${PORT}`);
  console.log(`Schedule: ON ${schedule.onHour}:${String(schedule.onMin).padStart(2,'0')}  OFF ${schedule.offHour}:${String(schedule.offMin).padStart(2,'0')}`);
});
