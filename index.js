// ═══════════════════════════════════════════════════════════════
//  DailyCare Backend  —  server/index.js  v4
//
//  Endpoints:
//    GET  /                  — health check
//    POST /save-subscription — receiver stores push sub (on-demand pings)
//    POST /save-schedule     — senior stores sub + medicine schedule (cron)
//    POST /send-push         — caregiver sends instant push to senior
//
//  Storage:
//    Redis (Railway plugin) — persists across server restarts
//    Falls back to in-memory Maps if REDIS_URL not set (local dev)
//
//  Cron:
//    Runs every minute, fires Web Push at each medicine time.
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const webpush  = require('web-push');
const cron     = require('node-cron');
const Redis    = require('ioredis');
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
//  REDIS — persists subscriptions + schedules across restarts
//
//  Redis keys:
//    ping:{channelId}        → JSON PushSubscription  (no expiry)
//    schedule:{userId}       → JSON schedule object   (no expiry)
//    fired:{userId}:{med}:{time}  → "YYYY-MM-DD"      (expires 25h)
//
//  If REDIS_URL is not set (local dev), falls back to in-memory Maps.
// ══════════════════════════════════════════════════════════════
let redis = null;

// In-memory fallbacks for local dev
const _pingMem     = new Map();
const _scheduleMem = new Map();
const _firedMem    = new Map();

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false
  });
  redis.on('connect',  () => console.log('[Redis] Connected ✓'));
  redis.on('error',    (e) => console.error('[Redis] Error:', e.message));
} else {
  console.warn('[Redis] REDIS_URL not set — using in-memory store (data lost on restart)');
}

// ── Redis helpers ──
async function rGet(key) {
  if (!redis) return null;
  try { return await redis.get(key); } catch(_) { return null; }
}
async function rSet(key, value, exSeconds = 0) {
  if (!redis) return;
  try {
    if (exSeconds > 0) await redis.set(key, value, 'EX', exSeconds);
    else               await redis.set(key, value);
  } catch(_) {}
}
async function rDel(key) {
  if (!redis) return;
  try { await redis.del(key); } catch(_) {}
}
async function rKeys(pattern) {
  if (!redis) return [];
  try { return await redis.keys(pattern); } catch(_) { return []; }
}

// ── Typed wrappers ──
async function getPingSub(channelId) {
  if (!redis) return _pingMem.get(channelId) || null;
  const v = await rGet('ping:' + channelId);
  return v ? JSON.parse(v) : null;
}
async function setPingSub(channelId, sub) {
  if (!redis) { _pingMem.set(channelId, sub); return; }
  await rSet('ping:' + channelId, JSON.stringify(sub));
}
async function delPingSub(channelId) {
  if (!redis) { _pingMem.delete(channelId); return; }
  await rDel('ping:' + channelId);
}

async function getSchedule(userId) {
  if (!redis) return _scheduleMem.get(userId) || null;
  const v = await rGet('schedule:' + userId);
  return v ? JSON.parse(v) : null;
}
async function setSchedule(userId, data) {
  if (!redis) { _scheduleMem.set(userId, data); return; }
  await rSet('schedule:' + userId, JSON.stringify(data));
}
async function delSchedule(userId) {
  if (!redis) { _scheduleMem.delete(userId); return; }
  await rDel('schedule:' + userId);
}
async function getAllScheduleUserIds() {
  if (!redis) return [..._scheduleMem.keys()];
  const keys = await rKeys('schedule:*');
  return keys.map(k => k.replace('schedule:', ''));
}

async function hasFired(userId, medName, time) {
  const key = `fired:${userId}:${medName}:${time}`;
  if (!redis) {
    const today = new Intl.DateTimeFormat('en-CA').format(new Date());
    return _firedMem.get(key) === today;
  }
  return !!(await rGet(key));
}
async function markFired(userId, medName, time) {
  const key = `fired:${userId}:${medName}:${time}`;
  if (!redis) {
    const today = new Intl.DateTimeFormat('en-CA').format(new Date());
    _firedMem.set(key, today); return;
  }
  // Expires in 25 hours — auto-cleans after midnight
  await rSet(key, '1', 25 * 60 * 60);
}

// ── Health check ──
app.get('/', async (_, res) => {
  const userIds = await getAllScheduleUserIds();
  res.json({
    status:  'DailyCare backend running ✓',
    storage: redis ? 'Redis' : 'in-memory',
    schedules: userIds.length
  });
});

// ══════════════════════════════════════════════════════════════
//  POST /save-subscription
//  Receiver saves their push sub so caregiver can ping them.
//  Body: { channelId, subscription }
// ══════════════════════════════════════════════════════════════
app.post('/save-subscription', async (req, res) => {
  const { channelId, subscription } = req.body || {};
  if (!channelId || !subscription?.endpoint)
    return res.status(400).json({ error: 'Missing channelId or subscription' });

  await setPingSub(channelId, subscription);
  console.log(`[Ping-Sub] Saved for channel ${channelId.slice(0, 8)}…`);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
//  POST /save-schedule
//  Senior saves subscription + medicine schedule.
//  Cron reads this every minute to fire reminders.
//  Body: { userId, name, subscription, timezone, medicines }
// ══════════════════════════════════════════════════════════════
app.post('/save-schedule', async (req, res) => {
  const { userId, name, subscription, timezone, medicines } = req.body || {};

  if (!userId || !subscription?.endpoint || !Array.isArray(medicines))
    return res.status(400).json({ error: 'Missing userId, subscription, or medicines' });

  await setSchedule(userId, {
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
//  Caregiver triggers instant push to senior.
//  Body: { channelId, type, fromName }
// ══════════════════════════════════════════════════════════════
app.post('/send-push', async (req, res) => {
  const { channelId, type, fromName } = req.body || {};
  if (!channelId || !type)
    return res.status(400).json({ error: 'Missing channelId or type' });

  const subscription = await getPingSub(channelId);
  if (!subscription)
    return res.status(404).json({ error: 'No subscription found — receiver must open the app first' });

  const isMed = type === 'medicine';
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
      await delPingSub(channelId);
      return res.status(410).json({ error: 'Subscription expired' });
    }
    console.error('[Ping] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  CRON — every minute
//  Reads all schedules from Redis, fires push at medicine times.
// ══════════════════════════════════════════════════════════════
cron.schedule('* * * * *', async () => {
  const userIds = await getAllScheduleUserIds();
  if (!userIds.length) return;

  const now = new Date();

  for (const userId of userIds) {
    const data = await getSchedule(userId);
    if (!data) continue;

    const { subscription, medicines, name, timezone } = data;

    // Current HH:MM in user's timezone
    const localTime = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);

    for (const med of medicines) {
      if (!med.name || !Array.isArray(med.reminderTimes)) continue;

      for (const time of med.reminderTimes) {
        if (time !== localTime) continue;
        if (await hasFired(userId, med.name, time)) continue;

        await markFired(userId, med.name, time);

        const payload = JSON.stringify({
          title: `💊 Time for ${med.name}`,
          body:  `${name}, it's time to take your ${med.name}.`,
          type:  'medicine',
          icon:  '/icons/icon-192.png',
          badge: '/icons/icon-192.png'
        });

        try {
          await webpush.sendNotification(subscription, payload);
          console.log(`[Cron] ✓ ${name} → ${med.name} at ${time} (${timezone})`);
        } catch (err) {
          if (err.statusCode === 410) {
            await delSchedule(userId);
            console.log(`[Cron] Removed expired schedule for ${userId.slice(0, 8)}…`);
            break;
          }
          console.error(`[Cron] Push failed for ${userId.slice(0, 8)}…:`, err.message);
        }
      }
    }
  }
});

console.log('[Cron] Scheduler started — fires every minute');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`DailyCare backend on port ${PORT}`));