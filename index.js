const express = require('express');
const cors    = require('cors');
const webpush = require('web-push');
const cron    = require('node-cron');
require('dotenv').config();

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error('FATAL: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set in Railway Variables.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '50kb' }));

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.length === 0 || ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  }
}));

webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@dailycare.app'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const pingSubscriptions = new Map();
const scheduleStore     = new Map();
const firedToday        = new Map();

app.get('/', (_, res) => res.json({
  status: 'DailyCare backend running',
  schedules: scheduleStore.size,
  pingSubscriptions: pingSubscriptions.size
}));

app.post('/save-subscription', (req, res) => {
  const { channelId, subscription } = req.body || {};
  if (!channelId || !subscription?.endpoint) {
    return res.status(400).json({ error: 'Missing channelId or subscription' });
  }
  pingSubscriptions.set(channelId, subscription);
  console.log('[Ping-Sub] Saved for channel ' + channelId.slice(0, 8));
  res.json({ ok: true });
});

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
  console.log('[Schedule] Saved ' + medicines.length + ' medicine(s) for ' + name);
  res.json({ ok: true, medicinesScheduled: medicines.length });
});

app.post('/send-push', async (req, res) => {
  const { channelId, type, fromName } = req.body || {};
  if (!channelId || !type) {
    return res.status(400).json({ error: 'Missing channelId or type' });
  }
  const subscription = pingSubscriptions.get(channelId);
  if (!subscription) {
    return res.status(404).json({ error: 'No subscription found - receiver must open the app first' });
  }
  const isMed   = type === 'medicine';
  const payload = JSON.stringify({
    title: isMed ? 'Time for your medicine!' : 'Time to drink water!',
    body:  'Reminder from ' + (fromName || 'Your caregiver'),
    type,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png'
  });
  try {
    await webpush.sendNotification(subscription, payload);
    console.log('[Ping] Sent ' + type + ' push for channel ' + channelId.slice(0, 8));
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

cron.schedule('* * * * *', async () => {
  if (!scheduleStore.size) return;
  const now = new Date();
  for (const [userId, data] of scheduleStore.entries()) {
    const { subscription, medicines, name, timezone } = data;
    const localTime = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
    for (const med of medicines) {
      if (!med.name || !Array.isArray(med.reminderTimes)) continue;
      for (const time of med.reminderTimes) {
        if (time !== localTime) continue;
        const fireKey = userId + ':' + med.name + ':' + time;
        if (firedToday.get(fireKey) === localDate) continue;
        firedToday.set(fireKey, localDate);
        const payload = JSON.stringify({
          title: 'Time for ' + med.name,
          body:  name + ', it is time to take your ' + med.name + '.',
          type:  'medicine',
          icon:  '/icons/icon-192.png',
          badge: '/icons/icon-192.png'
        });
        try {
          await webpush.sendNotification(subscription, payload);
          console.log('[Cron] Fired: ' + name + ' -> ' + med.name + ' at ' + time);
        } catch (err) {
          if (err.statusCode === 410) {
            scheduleStore.delete(userId);
            console.log('[Cron] Removed expired schedule for ' + userId.slice(0, 8));
            break;
          }
          console.error('[Cron] Push failed:', err.message);
        }
      }
    }
  }
  const todayDate = new Intl.DateTimeFormat('en-CA').format(now);
  for (const [key, date] of firedToday.entries()) {
    if (date !== todayDate) firedToday.delete(key);
  }
});

console.log('[Cron] Medicine reminder scheduler started');

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('DailyCare backend listening on port ' + PORT);
});
