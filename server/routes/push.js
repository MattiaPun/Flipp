// Web Push reminders: VAPID keys (generated once), subscriptions per device, daily "cards due" notification.
import { Router } from 'express';
import webpush from 'web-push';
import { db, getJsonSetting, setSetting } from '../db.js';
import { httpError, now, json, zonedParts } from '../util.js';
import { PUBLIC_URL } from '../auth.js';
import { registerJob } from '../jobs.js';
import { userTz, DUE } from '../study-core.js';
import { READABLE, readableParams } from '../access.js';

export const pushRouter = Router();

let vapid = null;
async function keys() {
  if (vapid) return vapid;
  vapid = await getJsonSetting('vapid', null);
  if (!vapid) {
    vapid = webpush.generateVAPIDKeys();
    await setSetting('vapid', JSON.stringify(vapid));
  }
  const subject = PUBLIC_URL.startsWith('https:') ? PUBLIC_URL : `mailto:${(process.env.MAIL_FROM || 'admin@localhost').replace(/^.*<|>.*$/g, '')}`;
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  return vapid;
}

async function send(sub, payload) {
  await keys();
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', sub.endpoint); // expired
    else console.warn('[flipp] push failed', e.statusCode || e.message);
    return false;
  }
}

pushRouter.get('/push/key', async (_req, res) => res.json({ publicKey: (await keys()).publicKey }));

// The server POSTs to whatever endpoint is stored, so only real browser push services are accepted (no SSRF).
// ponytail: fixed host allowlist (Chrome/Edge FCM, Firefox, Safari, legacy Edge); add a host if a browser ships a new push service.
const PUSH_HOST = /^((fcm|android)\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|([a-z0-9-]+\.)+push\.apple\.com|([a-z0-9-]+\.)+notify\.windows\.com)$/;
const validEndpoint = (e) => {
  try { const u = new URL(e); return u.protocol === 'https:' && !u.port && !u.username && !u.password && PUSH_HOST.test(u.hostname); } catch { return false; }
};

pushRouter.post('/push/subscribe', async (req, res) => {
  const { endpoint, keys: k } = req.body || {};
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !validEndpoint(endpoint) || typeof k?.p256dh !== 'string' || typeof k?.auth !== 'string') throw httpError(400, 'Invalid subscription');
  await db.run(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`, endpoint, req.user.id, k.p256dh.slice(0, 200), k.auth.slice(0, 100), now());
  res.json({ ok: true });
});

pushRouter.post('/push/unsubscribe', async (req, res) => {
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(req.body?.endpoint || ''), req.user.id);
  res.json({ ok: true });
});

pushRouter.post('/push/test', async (req, res) => {
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', req.user.id);
  if (!subs.length) throw httpError(400, 'No device is subscribed yet');
  let sent = 0;
  for (const s of subs) if (await send(s, { title: 'Flipp', body: 'Test notification. Reminders are on.', url: '/#/' })) sent++;
  res.json({ sent });
});

async function dueCount(user) {
  const t = now();
  const r = await db.get(`SELECT COUNT(*) AS n FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id
    WHERE p.user_id = ? AND ${DUE} AND ${READABLE}`, user.id, t, t, ...readableParams(user));
  return Number(r.n);
}

// Every minute: users whose local reminder time has arrived (and weren't reminded today) get one notification.
registerJob('reminders', async () => {
  const users = await db.all(`SELECT DISTINCT u.id, u.role, u.prefs FROM users u JOIN push_subscriptions ps ON ps.user_id = u.id WHERE u.prefs LIKE '%"reminder":"%'`);
  for (const u of users) {
    const prefs = json(u.prefs, {});
    if (!prefs.reminder) continue;
    const tz = await userTz(u.id);
    const local = zonedParts(now(), tz);
    const [h, m] = prefs.reminder.split(':').map(Number);
    if (local.minutes < h * 60 + m || prefs.lastReminder === local.date) continue;
    prefs.lastReminder = local.date;
    await db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), u.id);
    if (local.minutes > h * 60 + m + 120) continue; // server was down at reminder time; don't nag hours late
    const due = await dueCount(u);
    if (!due) continue;
    for (const s of await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', u.id)) {
      await send(s, { title: 'Flipp', body: `${due} card${due === 1 ? '' : 's'} due today. A few minutes keeps your streak alive.`, url: '/#/study' });
    }
  }
});
