import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, UPLOAD_DIR, setSetting } from './db.js';
import { authRouter, sessionMiddleware, requireUser, requireAdmin, httpError, registrationOpen, rateLimit, PUBLIC_URL, hashPassword } from './auth.js';
import { schedule, weakFirst } from './srs.js';
import { toCSV, shuffle } from '../public/lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const now = () => Date.now();
const NEW_PER_SESSION = Number(process.env.NEW_CARDS_PER_SESSION || 20);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

// ---------- Security headers ----------
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "font-src 'self' data:", "connect-src 'self'", "media-src 'self'", "object-src 'none'", "base-uri 'none'",
      "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'", "worker-src 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ---------- API: CSRF + CORS boundary ----------
// No CORS headers are ever sent, so browsers block cross-origin reads. State-changing requests must
// (1) come from our own origin and (2) carry the custom X-Flipp header, which cross-site forms cannot set.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return req.method === 'OPTIONS' ? res.sendStatus(204) : next();
  const origin = req.get('origin');
  const self = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const site = req.get('sec-fetch-site');
  if ((origin && origin !== self) || (site && site !== 'same-origin') || req.get('x-flipp') !== '1') return next(httpError(403, 'Cross-site request blocked'));
  next();
});
app.use('/api', express.json({ limit: '1mb' }), sessionMiddleware);
app.use('/api/auth', authRouter);
app.use('/api', requireUser);

// ---------- Validation helpers ----------
const str = (v, max, { min = 0, def } = {}) => {
  if (v === undefined && def !== undefined) return def;
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw httpError(400, `Invalid field (expected ${min}–${max} characters)`);
  return v.trim();
};
const IMAGE = /^\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const image = (v) => (v ? (IMAGE.test(v) ? v : (() => { throw httpError(400, 'Invalid image'); })()) : null);
const id = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw httpError(404, 'Not found'); return n; };

// ---------- Access control ----------
const canEdit = (user, course) => course.owner_id === user.id || user.role === 'admin';
async function loadCourse(req, courseId, write = false) {
  const c = await db.get('SELECT * FROM courses WHERE id = ?', id(courseId));
  if (!c || !(canEdit(req.user, c) || (!write && c.visibility === 'public'))) throw httpError(404, 'Course not found');
  return { ...c, canEdit: canEdit(req.user, c) };
}
async function loadSet(req, setId, write = false) {
  const s = await db.get('SELECT * FROM sets WHERE id = ?', id(setId));
  if (!s) throw httpError(404, 'Set not found');
  return { ...s, course: await loadCourse(req, s.course_id, write) };
}
async function loadCard(req, cardId, write = false) {
  const c = await db.get('SELECT * FROM cards WHERE id = ?', id(cardId));
  if (!c) throw httpError(404, 'Card not found');
  await loadSet(req, c.set_id, write);
  return c;
}
const courseInput = (b, user) => ({
  title: str(b.title, 120, { min: 1 }),
  description: str(b.description, 2000, { def: '' }),
  icon: str(b.icon, 16, { def: '' }),
  tags: str(b.tags, 300, { def: '' }).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12).join(','),
  lang: str(b.lang, 20, { def: '' }),
  visibility: b.visibility === 'public' && user.role === 'admin' ? 'public' : 'private', // only admins publish public courses
});

// ---------- Courses ----------
const VISIBLE = '(c.owner_id = ? OR c.visibility = ?)';
app.get('/api/courses', async (req, res) => {
  const t = now();
  const rows = await db.all(
    `SELECT c.*, u.name AS owner_name,
       (SELECT COUNT(*) FROM sets s WHERE s.course_id = c.id) AS set_count,
       (SELECT COUNT(*) FROM cards k JOIN sets s ON s.id = k.set_id WHERE s.course_id = c.id) AS card_count,
       (SELECT COUNT(*) FROM cards k JOIN sets s ON s.id = k.set_id JOIN progress p ON p.card_id = k.id AND p.user_id = ?
          WHERE s.course_id = c.id AND p.next_due <= ?) AS due_count
     FROM courses c JOIN users u ON u.id = c.owner_id WHERE ${VISIBLE} ORDER BY c.created_at DESC`,
    req.user.id, t, req.user.id, 'public');
  res.json(rows.map((c) => ({ ...c, canEdit: canEdit(req.user, c) })));
});
app.post('/api/courses', async (req, res) => {
  const c = courseInput(req.body, req.user);
  res.json(await db.get('INSERT INTO courses (owner_id, title, description, icon, tags, lang, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    req.user.id, c.title, c.description, c.icon, c.tags, c.lang, c.visibility, now()));
});
app.get('/api/courses/:id', async (req, res) => {
  const course = await loadCourse(req, req.params.id);
  const sets = await db.all(
    `SELECT s.*, (SELECT COUNT(*) FROM cards k WHERE k.set_id = s.id) AS card_count,
       (SELECT COUNT(*) FROM cards k JOIN progress p ON p.card_id = k.id AND p.user_id = ? WHERE k.set_id = s.id AND p.next_due <= ?) AS due_count,
       (SELECT COUNT(*) FROM cards k JOIN progress p ON p.card_id = k.id AND p.user_id = ? WHERE k.set_id = s.id AND p.stability >= 21) AS mastered_count
     FROM sets s WHERE s.course_id = ? ORDER BY s.created_at`, req.user.id, now(), req.user.id, course.id);
  res.json({ ...course, sets });
});
app.put('/api/courses/:id', async (req, res) => {
  const old = await loadCourse(req, req.params.id, true);
  const c = courseInput(req.body, req.user);
  if (req.user.role !== 'admin') c.visibility = old.visibility === 'public' ? 'public' : 'private';
  await db.run('UPDATE courses SET title = ?, description = ?, icon = ?, tags = ?, lang = ?, visibility = ? WHERE id = ?',
    c.title, c.description, c.icon, c.tags, c.lang, c.visibility, old.id);
  res.json({ ok: true });
});
app.delete('/api/courses/:id', async (req, res) => {
  const c = await loadCourse(req, req.params.id, true);
  await db.run('DELETE FROM courses WHERE id = ?', c.id);
  res.json({ ok: true });
});

// ---------- Sets ----------
app.post('/api/courses/:id/sets', async (req, res) => {
  const c = await loadCourse(req, req.params.id, true);
  res.json(await db.get('INSERT INTO sets (course_id, title, description, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    c.id, str(req.body.title, 120, { min: 1 }), str(req.body.description, 2000, { def: '' }), now()));
});
app.get('/api/sets/:id', async (req, res) => {
  const set = await loadSet(req, req.params.id);
  const cards = await db.all(
    `SELECT k.*, COALESCE(p.starred, 0) AS starred, p.stability, p.lapses, p.next_due, p.last_reviewed
     FROM cards k LEFT JOIN progress p ON p.card_id = k.id AND p.user_id = ? WHERE k.set_id = ? ORDER BY k.position, k.id`,
    req.user.id, set.id);
  res.json({ ...set, cards });
});
app.put('/api/sets/:id', async (req, res) => {
  const s = await loadSet(req, req.params.id, true);
  await db.run('UPDATE sets SET title = ?, description = ? WHERE id = ?', str(req.body.title, 120, { min: 1 }), str(req.body.description, 2000, { def: '' }), s.id);
  res.json({ ok: true });
});
app.delete('/api/sets/:id', async (req, res) => {
  const s = await loadSet(req, req.params.id, true);
  await db.run('DELETE FROM sets WHERE id = ?', s.id);
  res.json({ ok: true });
});
app.get('/api/sets/:id/export.csv', async (req, res) => {
  const s = await loadSet(req, req.params.id);
  const cards = await db.all('SELECT front, back FROM cards WHERE set_id = ? ORDER BY position, id', s.id);
  const name = s.title.replace(/[^\w\- ]+/g, '').trim() || 'set';
  res.type('text/csv').attachment(`${name}.csv`).send('﻿' + toCSV([['front', 'back'], ...cards.map((c) => [c.front, c.back])]));
});

// ---------- Cards ----------
app.post('/api/sets/:id/cards', async (req, res) => {
  const s = await loadSet(req, req.params.id, true);
  const list = Array.isArray(req.body.cards) ? req.body.cards : [req.body];
  if (!list.length || list.length > 2000) throw httpError(400, 'Between 1 and 2000 cards per request');
  const rows = list.map((c) => [str(c.front, 20000, { min: 1 }), str(c.back ?? '', 20000), image(c.image)]);
  let pos = Number((await db.get('SELECT MAX(position) AS m FROM cards WHERE set_id = ?', s.id))?.m ?? -1);
  const ids = [];
  // ponytail: one INSERT per card, no transaction; batch it if multi-thousand imports get slow
  for (const [front, back, img] of rows) {
    ids.push((await db.get('INSERT INTO cards (set_id, front, back, image, position, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', s.id, front, back, img, ++pos, now())).id);
  }
  res.json({ ids });
});
app.put('/api/cards/:id', async (req, res) => {
  const c = await loadCard(req, req.params.id, true);
  await db.run('UPDATE cards SET front = ?, back = ?, image = ? WHERE id = ?', str(req.body.front, 20000, { min: 1 }), str(req.body.back ?? '', 20000), image(req.body.image), c.id);
  res.json({ ok: true });
});
app.delete('/api/cards/:id', async (req, res) => {
  const c = await loadCard(req, req.params.id, true);
  await db.run('DELETE FROM cards WHERE id = ?', c.id);
  res.json({ ok: true });
});
app.post('/api/cards/:id/star', async (req, res) => {
  const c = await loadCard(req, req.params.id);
  await db.run('INSERT INTO progress (user_id, card_id, starred) VALUES (?, ?, ?) ON CONFLICT (user_id, card_id) DO UPDATE SET starred = excluded.starred',
    req.user.id, c.id, req.body.starred ? 1 : 0);
  res.json({ ok: true });
});

// ---------- Study ----------
// mode=srs: due cards (weakest first) + up to N new cards. mode=all: every card (flip / write / match).
app.get('/api/study', async (req, res) => {
  let where, params;
  if (req.query.set) { const s = await loadSet(req, req.query.set); where = 'k.set_id = ?'; params = [s.id]; }
  else if (req.query.course) { const c = await loadCourse(req, req.query.course); where = 's.course_id = ?'; params = [c.id]; }
  else { where = `${VISIBLE.replace(/c\./g, 'co.')}`; params = [req.user.id, 'public']; }
  let cards = await db.all(
    `SELECT k.id, k.set_id, k.front, k.back, k.image, co.lang, p.stability, p.difficulty, p.lapses, p.last_reviewed, p.next_due, COALESCE(p.starred, 0) AS starred
     FROM cards k JOIN sets s ON s.id = k.set_id JOIN courses co ON co.id = s.course_id
     LEFT JOIN progress p ON p.card_id = k.id AND p.user_id = ? WHERE ${where} ORDER BY k.position, k.id`,
    req.user.id, ...params);
  if (req.query.starred === '1') cards = cards.filter((c) => c.starred);
  if (req.query.mode === 'srs') {
    const t = now();
    const due = cards.filter((c) => c.last_reviewed != null && c.next_due <= t).sort(weakFirst);
    const fresh = req.query.set || req.query.course ? cards.filter((c) => c.last_reviewed == null).slice(0, NEW_PER_SESSION) : [];
    cards = [...due, ...fresh];
  } else if (req.query.shuffle === '1') cards = shuffle(cards);
  res.json(cards);
});

app.post('/api/review', async (req, res) => {
  const card = await loadCard(req, req.body.cardId);
  const rating = Number(req.body.rating);
  if (![1, 2, 3, 4].includes(rating)) throw httpError(400, 'Rating must be 1–4');
  const prev = await db.get('SELECT * FROM progress WHERE user_id = ? AND card_id = ?', req.user.id, card.id);
  const next = schedule(prev, rating);
  await db.run(
    `INSERT INTO progress (user_id, card_id, stability, difficulty, lapses, reps, last_reviewed, next_due, starred) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, card_id) DO UPDATE SET stability = excluded.stability, difficulty = excluded.difficulty, lapses = excluded.lapses,
       reps = excluded.reps, last_reviewed = excluded.last_reviewed, next_due = excluded.next_due`,
    req.user.id, card.id, next.stability, next.difficulty, next.lapses, next.reps, next.last_reviewed, next.next_due, prev?.starred || 0);
  const r = await db.get('INSERT INTO reviews (user_id, card_id, rating, prev, ts) VALUES (?, ?, ?, ?, ?) RETURNING id',
    req.user.id, card.id, rating, prev ? JSON.stringify(prev) : null, now());
  res.json({ reviewId: r.id, progress: next });
});

// Undo: restore the progress snapshot captured with the review, then drop the review.
app.delete('/api/review/:id', async (req, res) => {
  const r = await db.get('SELECT * FROM reviews WHERE id = ? AND user_id = ?', id(req.params.id), req.user.id);
  if (!r) throw httpError(404, 'Review not found');
  const p = r.prev ? JSON.parse(r.prev) : null;
  if (p) {
    await db.run('UPDATE progress SET stability = ?, difficulty = ?, lapses = ?, reps = ?, last_reviewed = ?, next_due = ? WHERE user_id = ? AND card_id = ?',
      p.stability, p.difficulty, p.lapses, p.reps, p.last_reviewed, p.next_due, req.user.id, r.card_id);
  } else {
    await db.run('UPDATE progress SET stability = 0, difficulty = 0, lapses = 0, reps = 0, last_reviewed = NULL, next_due = NULL WHERE user_id = ? AND card_id = ?', req.user.id, r.card_id);
  }
  await db.run('DELETE FROM reviews WHERE id = ?', r.id);
  res.json({ ok: true });
});

// Streak / today / due. tz = client's Date#getTimezoneOffset() so "days" match the user's calendar.
app.get('/api/stats', async (req, res) => {
  const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0)) * 60_000;
  const day = (ts) => Math.floor((ts - tz) / 86_400_000);
  const rows = await db.all('SELECT ts FROM reviews WHERE user_id = ? AND ts > ? ORDER BY ts DESC', req.user.id, now() - 400 * 86_400_000);
  const days = new Set(rows.map((r) => day(r.ts)));
  const today = day(now());
  let streak = 0;
  for (let d = days.has(today) ? today : today - 1; days.has(d); d--) streak++;
  const due = await db.get(
    `SELECT COUNT(*) AS n FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id
     WHERE p.user_id = ? AND p.next_due <= ? AND ${VISIBLE}`, req.user.id, now(), req.user.id, 'public');
  res.json({ streak, today: rows.filter((r) => day(r.ts) === today).length, due: Number(due.n), studiedToday: days.has(today) });
});

// ---------- Match leaderboard ----------
app.get('/api/sets/:id/match', async (req, res) => {
  const s = await loadSet(req, req.params.id);
  res.json(await db.all('SELECT m.ms, m.created_at, u.name FROM match_scores m JOIN users u ON u.id = m.user_id WHERE m.set_id = ? ORDER BY m.ms LIMIT 10', s.id));
});
app.post('/api/sets/:id/match', async (req, res) => {
  const s = await loadSet(req, req.params.id);
  const ms = Math.round(Number(req.body.ms));
  if (!(ms >= 1000 && ms < 3_600_000)) throw httpError(400, 'Invalid time');
  await db.run('INSERT INTO match_scores (set_id, user_id, ms, created_at) VALUES (?, ?, ?, ?)', s.id, req.user.id, ms, now());
  res.json({ ok: true });
});

// ---------- Uploads (images only; magic bytes checked, never SVG) ----------
const MAGIC = [['png', '89504e47'], ['jpg', 'ffd8ff'], ['gif', '47494638'], ['webp', '52494646']];
app.post('/api/uploads', rateLimit(60, 60_000), express.raw({ type: 'image/*', limit: '8mb' }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, 'Send an image body');
  const hex = buf.subarray(0, 12).toString('hex');
  const ext = MAGIC.find(([e, m]) => hex.startsWith(m) && (e !== 'webp' || hex.slice(16, 24) === '57454250'))?.[0];
  if (!ext) throw httpError(415, 'Only PNG, JPEG, GIF or WebP images are allowed');
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), buf);
  res.json({ url: `/uploads/${name}` });
});

// ---------- Admin ----------
app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  res.json(await db.all('SELECT id, email, name, role, created_at, oidc_sub IS NOT NULL AS sso, (SELECT COUNT(*) FROM courses c WHERE c.owner_id = users.id) AS courses FROM users ORDER BY id'));
});
app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const email = str(req.body.email, 254, { min: 3 }).toLowerCase();
  if (await db.get('SELECT id FROM users WHERE email = ?', email)) throw httpError(409, 'Email already in use');
  await db.run('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    email, str(req.body.name || email.split('@')[0], 80), await hashPassword(str(req.body.password, 256, { min: 8 })), req.body.role === 'admin' ? 'admin' : 'user', now());
  res.json({ ok: true });
});
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const uid = id(req.params.id);
  if (uid === req.user.id) throw httpError(400, "You can't change your own role");
  await db.run('UPDATE users SET role = ? WHERE id = ?', req.body.role === 'admin' ? 'admin' : 'user', uid);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const uid = id(req.params.id);
  if (uid === req.user.id) throw httpError(400, "You can't delete yourself");
  await db.run('DELETE FROM users WHERE id = ?', uid);
  res.json({ ok: true });
});
app.get('/api/admin/settings', requireAdmin, async (_req, res) => {
  res.json({
    allowRegistration: await registrationOpen(),
    invites: await db.all('SELECT i.code, i.expires_at, u.email AS used_by_email FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.expires_at DESC LIMIT 50'),
  });
});
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  await setSetting('allow_registration', req.body.allowRegistration ? 'true' : 'false');
  res.json({ ok: true });
});
app.post('/api/admin/invites', requireAdmin, async (req, res) => {
  const code = crypto.randomBytes(12).toString('base64url');
  await db.run('INSERT INTO invites (code, created_by, expires_at) VALUES (?, ?, ?)', code, req.user.id, now() + 7 * 86_400_000);
  res.json({ code });
});
app.delete('/api/admin/invites/:code', requireAdmin, async (req, res) => {
  await db.run('DELETE FROM invites WHERE code = ?', String(req.params.code));
  res.json({ ok: true });
});

app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));

// ---------- Static: app shell, vendored libs, uploads ----------
const vendor = { 'htm-preact.js': 'htm/preact/standalone.module.js', 'marked.js': 'marked/lib/marked.esm.js', 'purify.js': 'dompurify/dist/purify.es.mjs' };
for (const [name, file] of Object.entries(vendor)) app.get(`/vendor/${name}`, (_req, res) => res.sendFile(path.join(NM, file), { maxAge: '7d' }));
app.use('/vendor/katex', express.static(path.join(NM, 'katex/dist'), { maxAge: '7d' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '365d', immutable: true, index: false, dotfiles: 'deny' }));
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status < 500 && (err.expose ?? true) ? err.message : 'Internal server error' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`[flipp] listening on :${port}`));
