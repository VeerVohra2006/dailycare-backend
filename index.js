cat > /home/claude/server/index.js << 'EOF'
// ═══════════════════════════════════════════════════════════════
//  DailyCare Backend  —  server/index.js  v3
//
//  Endpoints:
//    GET  /                    — health check
//    POST /save-subscription   — receiver stores push subscription (on-demand pings)
//    POST /save-schedule       — senior stores subscription + medicine schedule (cron reminders)
//    POST /send-push           — caregiver triggers an instant push to a peer
//
//  Cron:
//    Runs every minute, checks all saved schedules, fires Web Push
//    at the exact medicine time — wakes locked iOS + Android screens.
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const webpush  = require('web-push');
const cron     = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50kb' }));

// ── CORS ──
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.length === 0 || ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  }
}));

// ── VAPID ──
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@dailycare.app'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ══════════════════════════════════════════════════════════════
//  IN-MEMORY STORES
//  Both reset on server restart (Railway free restarts ~daily).
//  The frontend re-saves automatically on next open — seamless.
// ══════════════════════════════════════════════════════════════

// On-demand push (caregiver → senior ping)
// Map<channelId, PushSubscription>
const pingSubscriptions = new Map();

// Scheduled medicine reminders (senior's own alarms)
// Map<userId, { subscription, medicines, name, timezone }>
const scheduleStore = new Map();

// Tracks which alarms fired today so we don't double-fire
// Map<"userId:medicineName:HH:MM", dateString "YYYY-MM-DD">
const firedToday = new Map();

// ── Health check ──
app.get('/', (_, res) => res.json({
  status: 'DailyCare backend running ✓',
  schedules: scheduleStore.size,
  pingSubscriptions: pingSubscriptions.size
}));

// ══════════════════════════════════════════════════════════════
//  POST /save-subscription
//  Receiver (caregiver side) saves their subscription so the
//  senior can send on-demand pings to them.
//  Body: { channelId, subscription }
// ══════════════════════════════════════════════════════════════
app.post('/save-subscription', (req, res) => {
  const { channelId, subscription } = req.body || {};
  if (!channelId || !subscription?.endpoint) {
    return res.status(400).json({ error: 'Missing channelId or subscription' });
  }
  pingSubscriptions.set(channelId, subscription);
  console.log(`[Ping-Sub] Saved for channel ${channelId.slice(0, 8)}…`);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  POST /save-schedule
//  Senior saves their own push subscription + medicine schedule.
//  Backend cron fires Web Push at each medicine time every day.
//
//  Body: {
//    userId,       — unique ID for this user (from localStorage)
//    name,         — senior's name (for notification body)
//    subscription, — Web Push subscription object
//    timezone,     — e.g. "Asia/Kolkata"
//    medicines: [  — array of medicine objects
//      { name, reminderTimes: ["08:00", "14:00", "21:00"] }
//    ]
//  }
// ══════════════════════════════════════════════════════════════
app.post('/save-schedule', (req, res) => {
  const { userId, name, subscription, timezone, medicines } = req.body || {};

  if (!userId || !subscription?.endpoint || !Array.isArray(medicines)) {
    return res.status(400).json({ error: 'Missing userId, subscription, or medicines' });
  }

  scheduleStore.set(userId, {
    subscription,
    medicines,
    name:     name     || 'Someone',
    timezone: timezone || 'Asia/Kolkata',
    savedAt:  Date.now()
  });

  console.log(`[Schedule] Saved ${medicines.length} medicine(s) for ${name} (${userId.slice(0, 8)}…)`);
  res.json({ ok: true, medicinesScheduled: medicines.length });
});

// ══════════════════════════════════════════════════════════════
//  POST /send-push
//  Caregiver sends an instant on-demand push to the senior.
//  Body: { channelId, type, fromName }
// ══════════════════════════════════════════════════════════════
app.post('/send-push', async (req, res) => {
  const { channelId, type, fromName } = req.body || {};
  if (!channelId || !type) {
    return res.status(400).json({ error: 'Missing channelId or type' });
  }

  const subscription = pingSubscriptions.get(channelId);
  if (!subscription) {
    return res.status(404).json({
      error: 'No subscription found — receiver must open the app first'
    });
  }

  const isMed  = type === 'medicine';
  const payload = JSON.stringify({
    title: isMed ? '💊 Time for your medicine!' : '💧 Time to drink water!',
    body:  `Reminder from ${fromName || 'Your caregiver'}`,
    type,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png'
  });

  try {
    await webpush.sendNotification(subscription, payload);
    console.log(`[Ping] Sent ${type} push for channel ${channelId.slice(0, 8)}…`);
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode === 410) {
      pingSubscriptions.delete(channelId);
      return res.status(410).json({ error: 'Subscription expired' });
    }
    console.error('[Ping] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  CRON — runs every minute
//  For each saved schedule, checks if any medicine time matches
//  the current time in the user's timezone, and fires Web Push.
// ══════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  if (!scheduleStore.size) return;

  const now = new Date();

  for (const [userId, data] of scheduleStore.entries()) {
    const { subscription, medicines, name, timezone } = data;

    // Get current HH:MM and date in the user's timezone
    const localTime = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour:   '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now);  // → "08:30"

    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year:  'numeric',
      month: '2-digit',
      day:   '2-digit'
    }).format(now);  // → "2026-06-29"

    for (const med of medicines) {
      if (!med.name || !Array.isArray(med.reminderTimes)) continue;

      for (const time of med.reminderTimes) {
        if (time !== localTime) continue;  // not yet

        const fireKey = `${userId}:${med.name}:${time}`;
        if (firedToday.get(fireKey) === localDate) continue;  // already fired

        // Fire!
        firedToday.set(fireKey, localDate);

        const payload = JSON.stringify({
          title: `💊 Time for ${med.name}`,
          body:  `${name}, it's time to take your ${med.name}.`,
          type:  'medicine',
          icon:  '/icons/icon-192.png',
          badge: '/icons/icon-192.png'
        });

        try {
          await webpush.sendNotification(subscription, payload);
          console.log(`[Cron] Fired reminder: ${name} → ${med.name} at ${time} (${timezone})`);
        } catch (err) {
          if (err.statusCode === 410) {
            // Subscription gone — remove this user's schedule
            scheduleStore.delete(userId);
            console.log(`[Cron] Removed expired schedule for ${userId.slice(0, 8)}…`);
            break;
          }
          console.error(`[Cron] Push failed for ${userId.slice(0, 8)}…:`, err.message);
        }
      }
    }
  }

  // Clean up firedToday entries older than today (midnight rollover)
  for (const [key, date] of firedToday.entries()) {
    const todayDate = new Intl.DateTimeFormat('en-CA').format(now);
    if (date !== todayDate) firedToday.delete(key);
  }
});

console.log('[Cron] Medicine reminder scheduler started — fires every minute');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`DailyCare backend on port ${PORT}`));
EOF