/*
 * ============================================================
 *  Relay Dashboard Server — Node.js / Express
 *  - Schedule saved to disk (survives Render restarts)
 *  - Server-side scheduler sends ON/OFF commands every 60s
 *  - Manual ON/OFF pauses scheduler until Return to Auto
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

// ── Schedule: load from disk, fallback to default ─────────────
function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf8"));
      console.log(`[SCHEDULE] Loaded from disk: ON ${data.onHour}:${String(data.onMin).padStart(2,'0')}  OFF ${data.offHour}:${String(data.offMin).padStart(2,'0')}`);
      return data;
    }
  } catch (e) {
    console.error("[SCHEDULE] Load failed:", e.message);
  }
  console.log("[SCHEDULE] Using default: ON 09:30  OFF 17:00");
  return { onHour: 9, onMin: 30, offHour: 17, offMin: 0 };
}

function saveScheduleToDisk(sched) {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(sched, null, 2));
    console.log(`[SCHEDULE] Saved to disk: ON ${sched.onHour}:${String(sched.onMin).padStart(2,'0')}  OFF ${sched.offHour}:${String(sched.offMin).padStart(2,'0')}`);
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

// ── Manual mode flag ──────────────────────────────────────────
// When true, scheduler is paused — user is in manual control
// Reset to false only when user clicks "Return to Auto"
let serverManualMode = false;

// ── Server-side scheduler ─────────────────────────────────────
function runScheduler() {
  // Skip if user manually turned ON or OFF from dashboard
  if (serverManualMode) {
    console.log("[SCHEDULER] Skipped — manual mode active.");
    return;
  }

  let h, m;

  // Use RTC time from last ESP32 heartbeat
  if (state.rtcTime && state.rtcTime !== "Unknown") {
    const parts = state.rtcTime.split(" ");
    if (parts.length === 2) {
      const t = parts[1].split(":");
      h = parseInt(t[0]);
      m = parseInt(t[1]);
    }
  }

  // Fallback to IST (UTC+5:30) if RTC not available
  if (h === undefined || isNaN(h)) {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    h = ist.getUTCHours();
    m = ist.getUTCMinutes();
  }

  const cur  = h * 60 + m;
  const onM  = schedule.onHour  * 60 + schedule.onMin;
  const offM = schedule.offHour * 60 + schedule.offMin;

  const shouldBeOn  = (cur >= onM && cur < offM);
  const currentlyOn = state.relay === "on";

  if (shouldBeOn !== currentlyOn) {
    state.pendingCommand = shouldBeOn ? "on" : "off";
    console.log(`[SCHEDULER] ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} → queuing ${state.pendingCommand.toUpperCase()}`);
  }
}

// Run every 60 seconds
setInterval(runScheduler, 60 * 1000);
// Run 3 seconds after startup
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

app.get("/schedule", checkDeviceAuth, (req, res) => {
  console.log(`[SCHEDULE] Sent to ESP32: ON ${schedule.onHour}:${String(schedule.onMin).padStart(2,'0')}  OFF ${schedule.offHour}:${String(schedule.offMin).padStart(2,'0')}`);
  res.json(schedule);
});

// ── Dashboard API ─────────────────────────────────────────────
app.get("/api/state", (req, res) => {
  res.json({
    ...state,
    schedule,
    serverManualMode,
    lastSeen: state.lastSeen ? state.lastSeen.toISOString() : null,
    onlineSeconds: state.lastSeen
      ? Math.floor((Date.now() - state.lastSeen) / 1000) : null,
  });
});

app.post("/api/control", (req, res) => {
  const { action } = req.body;
  if (!["on", "off", "auto"].includes(action))
    return res.status(400).json({ error: "action must be on | off | auto" });

  if (action === "auto") {
    // Return to auto — resume scheduler
    serverManualMode     = false;
    state.pendingCommand = "auto";
    console.log("[CMD] Returned to Auto — scheduler resumed.");
    // Run scheduler immediately to apply correct state
    runScheduler();
  } else {
    // Manual ON or OFF — pause scheduler
    serverManualMode     = true;
    state.pendingCommand = action;
    console.log(`[CMD] Manual ${action.toUpperCase()} — scheduler paused.`);
  }

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
  saveScheduleToDisk(schedule);

  // Saving a new schedule always returns to auto mode
  serverManualMode = false;
  runScheduler();

  res.json({ ok: true, schedule });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Relay dashboard running on port ${PORT}`);
  console.log(`Schedule: ON ${schedule.onHour}:${String(schedule.onMin).padStart(2,'0')}  OFF ${schedule.offHour}:${String(schedule.offMin).padStart(2,'0')}`);
});
