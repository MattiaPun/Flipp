// Studying: building queues, recording reviews (online + offline batches), undo, quick stats, leeches, match scores.
import { Router } from 'express';
import { db } from '../db.js';
import { httpError, id, now, startOfDay, dayKey, tagList, json } from '../util.js';
import { loadSet, loadCourse, loadCard, READABLE, readableParams, LISTED, listedParams } from '../access.js';
import { schedule, weakFirst, STATE } from '../../public/srs.js';
import { shuffle } from '../../public/lib.js';
import { DUE, variantsOf, courseConfig, userWeights, userTz } from '../study-core.js';

export const studyRouter = Router();
const LEARN_AHEAD = 20 * 60_000;

const CARD_COLS = `k.id, k.set_id, k.type, k.front, k.back, k.notes, k.mnemonic, k.example, k.image, k.audio, k.tags,
  s.reverse, s.course_id, c.lang, (SELECT 1 FROM stars st WHERE st.user_id = ? AND st.card_id = k.id) AS starred`;
const PROG_COLS = 'p.variant, p.state, p.step, p.stability, p.difficulty, p.lapses, p.reps, p.last_reviewed, p.next_due, p.suspended, p.buried_until, p.leech';

// Reviews done today per course (new introductions and review-state reviews), for daily limits.
async function todayCounts(userId, tz) {
  const since = startOfDay(now(), tz);
  const rows = await db.all(
    `SELECT s.course_id, SUM(r.was_new) AS new_n, SUM(CASE WHEN r.was_new = 0 AND r.state = 2 THEN 1 ELSE 0 END) AS rev_n
     FROM reviews r JOIN cards k ON k.id = r.card_id JOIN sets s ON s.id = k.set_id WHERE r.user_id = ? AND r.ts >= ? GROUP BY s.course_id`, userId, since);
  return new Map(rows.map((r) => [r.course_id, { new: Number(r.new_n) || 0, rev: Number(r.rev_n) || 0 }]));
}

// GET /study?set=|course=|tag= &mode=srs|all|cram &dir=front|back|both &starred=1
studyRouter.get('/study', async (req, res) => {
  const uid = req.user.id;
  const mode = ['srs', 'all', 'cram'].includes(req.query.mode) ? req.query.mode : 'srs';
  const dir = ['front', 'back', 'both'].includes(req.query.dir) ? req.query.dir : 'front';
  let where, params, scopeCourse = null;
  if (req.query.set) { const s = await loadSet(req, req.query.set); where = 'k.set_id = ?'; params = [s.id]; scopeCourse = s.course; }
  else if (req.query.course) { const c = await loadCourse(req, req.query.course); where = 's.course_id = ?'; params = [c.id]; scopeCourse = c; }
  else if (req.query.tag) {
    const tag = tagList(req.query.tag, 1)[0] || '';
    where = `${LISTED} AND (',' || k.tags || ',') LIKE ?`; params = [...listedParams(req.user), `%,${tag},%`];
  } else if (mode === 'srs') {
    // Global review: only cards the user has already started.
    where = `${READABLE} AND EXISTS (SELECT 1 FROM progress p2 WHERE p2.card_id = k.id AND p2.user_id = ? AND p2.state > 0)`;
    params = [...readableParams(req.user), uid];
  } else throw httpError(400, 'Pick a set, course or tag');

  const cards = await db.all(`SELECT ${CARD_COLS} FROM cards k JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id WHERE ${where} ORDER BY k.position, k.id`, uid, ...params);
  const ids = cards.map((c) => c.id);
  const prog = ids.length
    ? await db.all(`SELECT p.card_id, ${PROG_COLS} FROM progress p WHERE p.user_id = ? AND p.card_id IN (${ids.join(',')})`, uid)
    : [];
  const progMap = new Map(prog.map((p) => [`${p.card_id}:${p.variant}`, p]));
  const starredOnly = req.query.starred === '1';

  const items = [];
  for (const c of cards) {
    if (starredOnly && !c.starred) continue;
    const scheduled = variantsOf(c, { reverse: c.reverse });
    let variants = scheduled;
    if (mode !== 'srs' && c.type !== 'cloze') variants = dir === 'front' ? [0] : dir === 'back' ? [1] : [0, 1];
    for (const v of variants) {
      const p = progMap.get(`${c.id}:${v}`) || null;
      const { reverse, ...card } = c;
      items.push({ ...card, key: `${c.id}:${v}`, variant: v, starred: !!c.starred, scheduled: scheduled.includes(v), progress: p });
    }
  }

  const configs = {};
  for (const cid of new Set(cards.map((c) => c.course_id))) configs[cid] = await courseConfig(uid, cid);
  const t = now();
  let out;
  if (mode === 'srs') {
    const today = await todayCounts(uid, await userTz(uid));
    const left = new Map(Object.entries(configs).map(([cid, cfg]) => {
      const done = today.get(Number(cid)) || { new: 0, rev: 0 };
      return [Number(cid), { new: Math.max(0, cfg.newPerDay - done.new), rev: Math.max(0, cfg.reviewsPerDay - done.rev) }];
    }));
    const active = (p) => p && !p.suspended && !(p.buried_until > t);
    const learning = items.filter((i) => i.scheduled && active(i.progress) && (i.progress.state === STATE.LEARNING || i.progress.state === STATE.RELEARNING) && i.progress.next_due <= t + LEARN_AHEAD);
    const reviews = items.filter((i) => i.scheduled && active(i.progress) && i.progress.state === STATE.REVIEW && i.progress.next_due <= t)
      .sort((a, b) => weakFirst({ ...a.progress }, { ...b.progress }))
      .filter((i) => { const l = left.get(i.course_id); return l.rev-- > 0; });
    const fresh = (req.query.set || req.query.course || req.query.tag)
      ? items.filter((i) => i.scheduled && (!i.progress || (i.progress.state === STATE.NEW && !i.progress.suspended && !(i.progress.buried_until > t))))
        .filter((i) => { const l = left.get(i.course_id); return l.new-- > 0; })
      : [];
    out = [...learning.sort((a, b) => a.progress.next_due - b.progress.next_due), ...reviews, ...fresh];
  } else if (mode === 'cram') {
    out = items.filter((i) => !i.progress?.suspended).sort((a, b) => weakFirst({ ...a.progress, last_reviewed: a.progress?.last_reviewed ?? null }, { ...b.progress, last_reviewed: b.progress?.last_reviewed ?? null }));
  } else {
    out = req.query.shuffle === '1' ? shuffle(items) : items;
  }
  res.json({ items: out, configs, w: await userWeights(uid), now: t, course: scopeCourse ? { id: scopeCourse.id, title: scopeCourse.title, icon: scopeCourse.icon } : null });
});

// Applies one review. `ts` lets offline reviews keep their original time.
async function applyReview(req, { cardId, variant = 0, rating, ts }) {
  const card = await loadCard(req, cardId);
  const g = Number(rating);
  if (![1, 2, 3, 4].includes(g)) throw httpError(400, 'Rating must be 1–4');
  const v = Number(variant);
  if (!variantsOf(card, card.set).includes(v)) throw httpError(400, 'This card variant is not scheduled');
  const t = now();
  const at = Number.isFinite(ts) && ts <= t + 60_000 && ts >= t - 30 * 86_400_000 ? Math.round(Math.min(ts, t)) : t; // BIGINT column
  const uid = req.user.id;
  const prev = await db.get('SELECT * FROM progress WHERE user_id = ? AND card_id = ? AND variant = ?', uid, card.id, v);
  const config = await courseConfig(uid, card.set.course_id);
  const next = schedule(prev, g, at, { w: await userWeights(uid), config });
  let leech = prev?.leech || 0, suspended = prev?.suspended || 0;
  if (next.lapsed && next.lapses >= config.leechThreshold && (next.lapses - config.leechThreshold) % Math.max(1, Math.floor(config.leechThreshold / 2)) === 0) {
    leech = 1;
    if (config.leechAction === 'suspend') suspended = 1;
  }
  await db.run(
    `INSERT INTO progress (user_id, card_id, variant, state, step, stability, difficulty, lapses, reps, last_reviewed, next_due, suspended, leech, buried_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (user_id, card_id, variant) DO UPDATE SET state = excluded.state, step = excluded.step, stability = excluded.stability,
       difficulty = excluded.difficulty, lapses = excluded.lapses, reps = excluded.reps, last_reviewed = excluded.last_reviewed,
       next_due = excluded.next_due, suspended = excluded.suspended, leech = excluded.leech, buried_until = NULL`,
    uid, card.id, v, next.state, next.step, next.stability, next.difficulty, next.lapses, next.reps, next.last_reviewed, Math.round(next.next_due), suspended, leech);
  const wasNew = !prev || !prev.last_reviewed;
  const r = await db.get('INSERT INTO reviews (user_id, card_id, variant, rating, prev, ts, was_new, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    uid, card.id, v, g, prev ? JSON.stringify(prev) : null, at, wasNew ? 1 : 0, prev?.last_reviewed ? prev.state : 0);
  if (card.set.course.role === 'public') {
    await db.run('INSERT INTO saved_courses (user_id, course_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, course_id) DO NOTHING', uid, card.set.course_id, t);
  }
  return { reviewId: r.id, progress: { ...next, suspended, leech }, leech: !!leech && !prev?.leech, suspended: !!suspended };
}

studyRouter.post('/review', async (req, res) => {
  res.json(await applyReview(req, req.body || {}));
});

// Offline queue flush: [{ cardId, variant, rating, ts }], applied in time order. Duplicates (same card/variant/ts) are skipped.
studyRouter.post('/review/batch', async (req, res) => {
  const list = Array.isArray(req.body?.reviews) ? req.body.reviews.slice(0, 1000) : [];
  list.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  const results = [];
  for (const r of list) {
    try {
      const dup = Number.isFinite(r.ts) && await db.get('SELECT id FROM reviews WHERE user_id = ? AND card_id = ? AND variant = ? AND ts = ?', req.user.id, Number(r.cardId) || 0, Number(r.variant) || 0, Math.round(r.ts));
      results.push(dup ? { ok: true, duplicate: true } : { ok: true, ...(await applyReview(req, r)) });
    } catch (e) {
      results.push({ ok: false, error: e.expose ? e.message : 'failed' });
    }
  }
  res.json({ results });
});

// Undo: restore the progress snapshot captured with the review, then drop the review.
studyRouter.delete('/review/:id', async (req, res) => {
  const r = await db.get('SELECT * FROM reviews WHERE id = ? AND user_id = ?', id(req.params.id), req.user.id);
  if (!r) throw httpError(404, 'Review not found');
  // Each review's snapshot is the state the one before it left behind, so only the newest one can be rolled back.
  const latest = await db.get('SELECT MAX(id) AS id FROM reviews WHERE user_id = ? AND card_id = ? AND variant = ?', req.user.id, r.card_id, r.variant);
  if (Number(latest.id) !== Number(r.id)) throw httpError(409, 'Only the most recent review of a card can be undone');
  const p = json(r.prev, null);
  if (p) {
    await db.run(`UPDATE progress SET state = ?, step = ?, stability = ?, difficulty = ?, lapses = ?, reps = ?, last_reviewed = ?, next_due = ?,
      suspended = ?, leech = ?, buried_until = ? WHERE user_id = ? AND card_id = ? AND variant = ?`,
      p.state ?? 2, p.step ?? 0, p.stability, p.difficulty, p.lapses, p.reps, p.last_reviewed, p.next_due, p.suspended ?? 0, p.leech ?? 0, p.buried_until ?? null,
      req.user.id, r.card_id, r.variant);
  } else {
    await db.run('DELETE FROM progress WHERE user_id = ? AND card_id = ? AND variant = ?', req.user.id, r.card_id, r.variant);
  }
  await db.run('DELETE FROM reviews WHERE id = ?', r.id);
  res.json({ ok: true });
});

// Home-screen numbers: streak, reviews today, due now, daily goal.
studyRouter.get('/stats', async (req, res) => {
  const uid = req.user.id;
  const tz = await userTz(uid);
  const t = now();
  const rows = await db.all('SELECT ts FROM reviews WHERE user_id = ? AND ts > ? ORDER BY ts DESC', uid, t - 400 * 86_400_000);
  const days = new Set(rows.map((r) => dayKey(r.ts, tz)));
  const key = (offset) => dayKey(t - offset * 86_400_000, tz);
  let streak = 0;
  for (let i = days.has(key(0)) ? 0 : 1; days.has(key(i)); i++) streak++;
  const today = rows.filter((r) => r.ts >= startOfDay(t, tz)).length;
  const due = await db.get(
    `SELECT COUNT(*) AS n FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id
     WHERE p.user_id = ? AND ${DUE} AND ${READABLE}`, uid, t, t, ...readableParams(req.user));
  const prefs = json((await db.get('SELECT prefs FROM users WHERE id = ?', uid)).prefs, {});
  res.json({ streak, today, due: Number(due.n), studiedToday: days.has(key(0)), goal: prefs.dailyGoal || 0 });
});

// Leeches: cards the user keeps forgetting.
studyRouter.get('/leeches', async (req, res) => {
  res.json(await db.all(
    `SELECT k.id, k.front, k.back, k.type, k.set_id, s.title AS set_title, c.title AS course_title, c.icon, p.variant, p.lapses, p.suspended
     FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id
     WHERE p.user_id = ? AND p.leech = 1 AND ${READABLE} ORDER BY p.lapses DESC LIMIT 500`, req.user.id, ...readableParams(req.user)));
});

// ---------- Match leaderboard ----------
studyRouter.get('/sets/:id/match', async (req, res) => {
  const s = await loadSet(req, req.params.id);
  res.json(await db.all('SELECT m.ms, m.created_at, u.name FROM match_scores m JOIN users u ON u.id = m.user_id WHERE m.set_id = ? ORDER BY m.ms LIMIT 10', s.id));
});
studyRouter.post('/sets/:id/match', async (req, res) => {
  const s = await loadSet(req, req.params.id);
  const ms = Math.round(Number(req.body.ms));
  if (!(ms >= 1000 && ms < 3_600_000)) throw httpError(400, 'Invalid time');
  await db.run('INSERT INTO match_scores (set_id, user_id, ms, created_at) VALUES (?, ?, ?, ?)', s.id, req.user.id, ms, now());
  res.json({ ok: true });
});

// Full statistics dashboard: heatmap, forecast, retention, card states, hardest cards.
studyRouter.get('/stats/full', async (req, res) => {
  const uid = req.user.id;
  const tz = await userTz(uid);
  const t = now();
  const DAY = 86_400_000;
  const reviews = await db.all('SELECT ts, rating, state, was_new FROM reviews WHERE user_id = ? AND ts > ? ORDER BY ts', uid, t - 371 * DAY);
  const perDay = new Map();
  for (const r of reviews) { const k = dayKey(r.ts, tz); perDay.set(k, (perDay.get(k) || 0) + 1); }
  const heatmap = [];
  for (let i = 364; i >= 0; i--) { const k = dayKey(t - i * DAY, tz); heatmap.push({ date: k, count: perDay.get(k) || 0 }); }

  // Retention on review-state cards ("true retention"), per ISO-ish week for the last 26 weeks.
  const weekStart = startOfDay(t, tz) - 25 * 7 * DAY;
  const weeks = Array.from({ length: 26 }, (_, i) => ({ start: weekStart + i * 7 * DAY, total: 0, passed: 0 }));
  for (const r of reviews) {
    if (r.state !== 2 || r.ts < weekStart) continue;
    const w = weeks[Math.min(25, Math.floor((r.ts - weekStart) / (7 * DAY)))];
    w.total++; if (r.rating > 1) w.passed++;
  }
  const last30 = reviews.filter((r) => r.state === 2 && r.ts > t - 30 * DAY);

  const prog = await db.all(
    `SELECT p.state, p.stability, p.difficulty, p.lapses, p.next_due, p.suspended, p.variant, k.type, s.reverse
     FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id
     WHERE p.user_id = ? AND ${READABLE}`, uid, ...readableParams(req.user));
  const valid = prog.filter((p) => p.variant === 0 || p.type === 'cloze' || p.reverse === 1);
  const counts = { learning: 0, young: 0, mature: 0, suspended: 0 };
  const forecast = Array.from({ length: 30 }, () => 0);
  const today0 = startOfDay(t, tz);
  let overdue = 0;
  for (const p of valid) {
    if (p.suspended) { counts.suspended++; continue; }
    if (p.state === 0) continue;
    if (p.state === 1 || p.state === 3) counts.learning++;
    else if (p.stability >= 21) counts.mature++;
    else counts.young++;
    if (p.next_due < today0) overdue++;
    const d = Math.floor((p.next_due - today0) / DAY);
    if (d >= 0 && d < 30) forecast[d]++;
  }
  forecast[0] += overdue;
  const hardest = await db.all(
    `SELECT k.id, k.front, k.back, k.type, k.set_id, p.variant, p.lapses, p.difficulty, s.title AS set_title
     FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id
     WHERE p.user_id = ? AND p.lapses > 0 AND ${READABLE} ORDER BY p.lapses DESC, p.difficulty DESC LIMIT 10`, uid, ...readableParams(req.user));
  const total = await db.get('SELECT COUNT(*) AS n, MIN(ts) AS first FROM reviews WHERE user_id = ?', uid);
  res.json({
    heatmap,
    forecast: forecast.map((n, i) => ({ date: dayKey(today0 + i * DAY + 12 * 3_600_000, tz), count: n })),
    retention: weeks.map((w) => ({ start: w.start, total: w.total, rate: w.total ? w.passed / w.total : null })),
    retention30: last30.length ? last30.filter((r) => r.rating > 1).length / last30.length : null,
    counts, hardest,
    totals: { reviews: Number(total.n), since: total.first, activeDays: perDay.size, avgPerActiveDay: perDay.size ? Math.round(reviews.length / perDay.size) : 0 },
    optimized: !!(await userWeights(uid)),
  });
});
