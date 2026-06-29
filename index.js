// ═══════════════════════════════════════════════════════════════
//  DailyCare Backend  —  server/index.js
//
//  Endpoints:
//    POST /save-subscription   — receiver stores their push subscription
//    POST /send-push           — caregiver triggers a push to a peer
//    GET  /                    — health check
//
//  Deploy on Railway (free tier):
//    1. Push this folder to GitHub
//    2. New Project → Deploy from GitHub repo
//    3. Add env vars from .env.example
//    4. Settings → Networking → Generate Domain → copy URL into index.html
// ═══════════════════════════════════════════════════════════════

const express   = require('express');
const cors      = require('cors');
const webpush   = require('web-push');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10kb' }));

// ── CORS — allow your Vercel frontend ──
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.length === 0 || ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked: ' + origin));
  }
}));

// ── VAPID setup ──
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_EMAIL || 'admin@dailycare.app'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── In-memory subscription store ──
// Key: channelId (derived from peer secret)
// Value: Web Push subscription object
// Note: resets on server restart — fine for Railway free tier
// For persistence, swap with a simple JSON file or free Redis
const subscriptions = new Map();

// ── Health check ──
app.get('/', (_, res) => res.json({ status: 'DailyCare backend running ✓' }));

// ══════════════════════════════════════════════════════════
//  POST /save-subscription
//  Called by the RECEIVER when they open the shared profile.
//  Stores their push subscription keyed by channelId.
//
//  Body: { channelId, subscription }
// ══════════════════════════════════════════════════════════
app.post('/save-subscription', (req, res) => {
  const { channelId, subscription } = req.body || {};
  if (!channelId || !subscription?.endpoint) {
    return res.status(400).json({ error: 'Missing channelId or subscription' });
  }
  subscriptions.set(channelId, subscription);
  console.log(`[Sub] Saved subscription for channel ${channelId.slice(0, 8)}…`);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
//  POST /send-push
//  Called by the CAREGIVER when they tap Remind.
//  Looks up the receiver's subscription by channelId and sends push.
//
//  Body: { channelId, type, fromName }
//    channelId — shared secret channel (same derivation as ntfy)
//    type      — 'medicine' | 'water'
//    fromName  — caregiver's name
// ══════════════════════════════════════════════════════════
app.post('/send-push', async (req, res) => {
  const { channelId, type, fromName } = req.body || {};

  if (!channelId || !type) {
    return res.status(400).json({ error: 'Missing channelId or type' });
  }

  const subscription = subscriptions.get(channelId);
  if (!subscription) {
    return res.status(404).json({ error: 'No subscription found — receiver must open the app first' });
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
    console.log(`[Push] Sent ${type} push for channel ${channelId.slice(0, 8)}…`);
    res.json({ ok: true });
  } catch (err) {
    // 410 Gone = subscription expired/revoked — clean it up
    if (err.statusCode === 410) {
      subscriptions.delete(channelId);
      console.log(`[Push] Subscription expired, removed.`);
      return res.status(410).json({ error: 'Subscription expired — receiver needs to reopen app' });
    }
    console.error('[Push] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`DailyCare backend on port ${PORT}`));
