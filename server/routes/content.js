// Courses, sets and cards: CRUD, sharing, cloning, library saving, bulk actions, search and tags.
import { Router } from 'express';
import { db } from '../db.js';
import { httpError, id, now, str, image, audio, tagList, json, startOfDay, email as emailField } from '../util.js';
import { loadCourse, loadSet, loadCard, LISTED, listedParams, READABLE, readableParams, isAdmin } from '../access.js';
import { audit } from '../audit.js';
import { DUE, variantsOf, courseConfig, userTz } from '../study-core.js';
import { normalizeConfig } from '../../public/srs.js';
import { toCSV, clozeNumbers, plain } from '../../public/lib.js';

export const contentRouter = Router();

// ---------- Input shapes ----------
const courseInput = (b, user, old) => ({
  title: str(b.title, 120, { min: 1 }),
  description: str(b.description, 2000, { def: old?.description ?? '' }),
  icon: str(b.icon, 16, { def: old?.icon ?? '' }),
  tags: tagList(b.tags ?? old?.tags, 12).join(','),
  lang: str(b.lang, 20, { def: old?.lang ?? '' }),
});

export function cardInput(c) {
  const type = c.type === 'cloze' ? 'cloze' : 'basic';
  const front = str(c.front, 20000, { min: 1 });
  if (type === 'cloze' && !clozeNumbers(front).length) throw httpError(400, 'A cloze card needs at least one deletion like {{c1::answer}}');
  return {
    type, front,
    back: str(c.back ?? '', 20000),
    notes: str(c.notes ?? '', 5000),
    mnemonic: str(c.mnemonic ?? '', 2000),
    example: str(c.example ?? '', 5000),
    image: image(c.image),
    audio: audio(c.audio),
    tags: tagList(c.tags).join(','),
  };
}

const dupKey = (front) => plain(front).toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- Courses ----------
contentRouter.get('/courses', async (req, res) => {
  const t = now();
  const rows = await db.all(
    `SELECT c.*, u.name AS owner_name,
       (SELECT cm.role FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?) AS member_role,
       (SELECT COUNT(*) FROM sets s WHERE s.course_id = c.id) AS set_count,
       (SELECT COUNT(*) FROM cards k JOIN sets s ON s.id = k.set_id WHERE s.course_id = c.id) AS card_count,
       (SELECT COUNT(*) FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id
          WHERE s.course_id = c.id AND p.user_id = ? AND ${DUE}) AS due_count
     FROM courses c JOIN users u ON u.id = c.owner_id WHERE ${LISTED} ORDER BY c.created_at DESC`,
    req.user.id, req.user.id, t, t, ...listedParams(req.user));
  res.json(rows.map((c) => ({
    ...c, owned: c.owner_id === req.user.id,
    canEdit: c.owner_id === req.user.id || c.member_role === 'editor' || isAdmin(req.user),
  })));
});

contentRouter.post('/courses', async (req, res) => {
  const c = courseInput(req.body, req.user);
  const row = await db.get('INSERT INTO courses (owner_id, title, description, icon, tags, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    req.user.id, c.title, c.description, c.icon, c.tags, c.lang, now());
  res.json(row);
});

contentRouter.get('/courses/:id', async (req, res) => {
  const course = await loadCourse(req, req.params.id);
  const t = now();
  const sets = await db.all(
    `SELECT s.*, (SELECT COUNT(*) FROM cards k WHERE k.set_id = s.id) AS card_count,
       (SELECT COUNT(*) FROM progress p JOIN cards k ON k.id = p.card_id WHERE k.set_id = s.id AND p.user_id = ? AND ${DUE}) AS due_count,
       (SELECT COUNT(DISTINCT p.card_id) FROM progress p JOIN cards k ON k.id = p.card_id WHERE k.set_id = s.id AND p.user_id = ? AND p.state = 2 AND p.stability >= 21) AS mastered_count
     FROM sets s WHERE s.course_id = ? ORDER BY s.created_at, s.id`, req.user.id, t, t, req.user.id, course.id);
  const owner = await db.get('SELECT name FROM users WHERE id = ?', course.owner_id);
  const saved = await db.get('SELECT 1 AS ok FROM saved_courses WHERE user_id = ? AND course_id = ?', req.user.id, course.id);
  res.json({ ...course, owner_name: owner?.name, saved: !!saved, prefs: await courseConfig(req.user.id, course.id), sets });
});

contentRouter.put('/courses/:id', async (req, res) => {
  const old = await loadCourse(req, req.params.id, 'edit');
  const c = courseInput(req.body, req.user, old);
  await db.run('UPDATE courses SET title = ?, description = ?, icon = ?, tags = ?, lang = ? WHERE id = ?',
    c.title, c.description, c.icon, c.tags, c.lang, old.id);
  res.json({ ok: true });
});

contentRouter.delete('/courses/:id', async (req, res) => {
  const c = await loadCourse(req, req.params.id, 'manage');
  await db.run('DELETE FROM courses WHERE id = ?', c.id);
  await audit(req, 'course.deleted', { target: `course:${c.id}`, details: { title: c.title } });
  res.json({ ok: true });
});

// Owners share a course with everyone on the instance (the library) or take it back.
contentRouter.post('/courses/:id/publish', async (req, res) => {
  const c = await loadCourse(req, req.params.id, 'manage');
  const visibility = req.body.publish === false ? 'private' : 'public';
  await db.run('UPDATE courses SET visibility = ? WHERE id = ?', visibility, c.id);
  await audit(req, visibility === 'public' ? 'course.published' : 'course.unpublished', { target: `course:${c.id}` });
  res.json({ visibility });
});

// Library: keep a public course on your home screen.
contentRouter.post('/courses/:id/save', async (req, res) => {
  const c = await loadCourse(req, req.params.id);
  if (req.body.saved === false) await db.run('DELETE FROM saved_courses WHERE user_id = ? AND course_id = ?', req.user.id, c.id);
  else await db.run('INSERT INTO saved_courses (user_id, course_id, created_at) VALUES (?, ?, ?) ON CONFLICT (user_id, course_id) DO NOTHING', req.user.id, c.id, now());
  res.json({ ok: true });
});

// Personal study settings for this course (retention, limits, steps, leeches).
contentRouter.put('/courses/:id/prefs', async (req, res) => {
  const c = await loadCourse(req, req.params.id);
  const prefs = normalizeConfig(req.body || {});
  await db.run('INSERT INTO course_prefs (user_id, course_id, prefs) VALUES (?, ?, ?) ON CONFLICT (user_id, course_id) DO UPDATE SET prefs = excluded.prefs',
    req.user.id, c.id, JSON.stringify(prefs));
  res.json(prefs);
});

// Clone any readable course into your own private copy (no progress is copied).
contentRouter.post('/courses/:id/clone', async (req, res) => {
  const src = await loadCourse(req, req.params.id);
  const sets = await db.all('SELECT * FROM sets WHERE course_id = ? ORDER BY created_at, id', src.id);
  const cards = await db.all('SELECT k.* FROM cards k JOIN sets s ON s.id = k.set_id WHERE s.course_id = ? ORDER BY k.position, k.id', src.id);
  const newId = await db.tx(async (t) => {
    const c = await t.get('INSERT INTO courses (owner_id, title, description, icon, tags, lang, visibility, cloned_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      req.user.id, src.owner_id === req.user.id ? `${src.title} (copy)` : src.title, src.description, src.icon, src.tags, src.lang, 'private', src.id, now());
    const setMap = new Map();
    for (const s of sets) {
      const ns = await t.get('INSERT INTO sets (course_id, title, description, reverse, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id', c.id, s.title, s.description, s.reverse, now());
      setMap.set(s.id, ns.id);
    }
    for (const k of cards) {
      await t.run(`INSERT INTO cards (set_id, front, back, image, position, created_at, type, notes, mnemonic, example, audio, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, setMap.get(k.set_id), k.front, k.back, k.image, k.position, now(), k.type, k.notes, k.mnemonic, k.example, k.audio, k.tags);
    }
    return c.id;
  });
  await audit(req, 'course.cloned', { target: `course:${src.id}`, details: { into: newId } });
  res.json({ id: newId });
});

// ---------- Sharing (viewers / co-editors) ----------
contentRouter.get('/courses/:id/members', async (req, res) => {
  const c = await loadCourse(req, req.params.id, 'manage');
  res.json(await db.all('SELECT u.id, u.name, u.email, m.role, m.created_at FROM course_members m JOIN users u ON u.id = m.user_id WHERE m.course_id = ? ORDER BY m.created_at', c.id));
});

contentRouter.post('/courses/:id/members', async (req, res) => {
  const c = await loadCourse(req, req.params.id, 'manage');
  const role = req.body.role === 'editor' ? 'editor' : 'viewer';
  const target = await db.get('SELECT id, email FROM users WHERE email = ?', emailField(req.body.email));
  // Exact-email sharing only; no user directory. Same message for "no such user" keeps enumeration low-value.
  if (!target) throw httpError(404, 'No user with that email on this instance');
  if (target.id === c.owner_id) throw httpError(400, 'That user owns this course');
  await db.run('INSERT INTO course_members (course_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (course_id, user_id) DO UPDATE SET role = excluded.role',
    c.id, target.id, role, now());
  await audit(req, 'course.shared', { target: `course:${c.id}`, details: { with: target.email, role } });
  res.json({ ok: true });
});

contentRouter.delete('/courses/:id/members/:uid', async (req, res) => {
  const self = req.params.uid === 'me';
  const c = await loadCourse(req, req.params.id, self ? 'read' : 'manage');
  const uid = self ? req.user.id : id(req.params.uid);
  await db.run('DELETE FROM course_members WHERE course_id = ? AND user_id = ?', c.id, uid);
  await audit(req, 'course.unshared', { target: `course:${c.id}`, details: { user: uid } });
  res.json({ ok: true });
});

// ---------- Sets ----------
contentRouter.post('/courses/:id/sets', async (req, res) => {
  const c = await loadCourse(req, req.params.id, 'edit');
  res.json(await db.get('INSERT INTO sets (course_id, title, description, reverse, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    c.id, str(req.body.title, 120, { min: 1 }), str(req.body.description, 2000, { def: '' }), req.body.reverse ? 1 : 0, now()));
});

contentRouter.get('/sets/:id', async (req, res) => {
  const set = await loadSet(req, req.params.id);
  const cards = await db.all(
    `SELECT k.*, (SELECT 1 FROM stars st WHERE st.user_id = ? AND st.card_id = k.id) AS starred
     FROM cards k WHERE k.set_id = ? ORDER BY k.position, k.id`, req.user.id, set.id);
  const prog = await db.all(
    `SELECT p.card_id, p.variant, p.state, p.stability, p.lapses, p.next_due, p.suspended, p.leech
     FROM progress p JOIN cards k ON k.id = p.card_id WHERE k.set_id = ? AND p.user_id = ?`, set.id, req.user.id);
  const byCard = new Map();
  for (const p of prog) (byCard.get(p.card_id) || byCard.set(p.card_id, []).get(p.card_id)).push(p);
  const siblings = await db.all('SELECT id, title FROM sets WHERE course_id = ? ORDER BY created_at, id', set.course_id);
  res.json({ ...set, siblings, cards: cards.map((c) => ({ ...c, starred: !!c.starred, progress: byCard.get(c.id) || [] })) });
});

contentRouter.put('/sets/:id', async (req, res) => {
  const s = await loadSet(req, req.params.id, 'edit');
  await db.run('UPDATE sets SET title = ?, description = ?, reverse = ? WHERE id = ?',
    str(req.body.title, 120, { min: 1 }), str(req.body.description, 2000, { def: '' }), req.body.reverse === undefined ? s.reverse : req.body.reverse ? 1 : 0, s.id);
  res.json({ ok: true });
});

contentRouter.delete('/sets/:id', async (req, res) => {
  const s = await loadSet(req, req.params.id, 'edit');
  await db.run('DELETE FROM sets WHERE id = ?', s.id);
  res.json({ ok: true });
});

contentRouter.get('/sets/:id/export.csv', async (req, res) => {
  const s = await loadSet(req, req.params.id);
  const cards = await db.all('SELECT front, back, type, tags, notes FROM cards WHERE set_id = ? ORDER BY position, id', s.id);
  const name = s.title.replace(/[^\w\- ]+/g, '').trim() || 'set';
  res.type('text/csv').attachment(`${name}.csv`)
    .send('﻿' + toCSV([['front', 'back', 'type', 'tags', 'notes'], ...cards.map((c) => [c.front, c.back, c.type, c.tags, c.notes])]));
});

// Drag-and-drop order: full list of the set's card ids in the new order.
contentRouter.put('/sets/:id/order', async (req, res) => {
  const s = await loadSet(req, req.params.id, 'edit');
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
  const existing = (await db.all('SELECT id FROM cards WHERE set_id = ?', s.id)).map((r) => r.id);
  if (ids.length !== existing.length || !existing.every((x) => ids.includes(x))) throw httpError(400, 'Order must list every card in the set exactly once');
  await db.tx(async (t) => { for (let i = 0; i < ids.length; i++) await t.run('UPDATE cards SET position = ? WHERE id = ? AND set_id = ?', i, ids[i], s.id); });
  res.json({ ok: true });
});

// ---------- Cards ----------
// Body: a single card, or { cards: [...], skipDuplicates }. A single card that duplicates an existing front
// returns 409 { code: 'duplicate' } unless `force` is set.
contentRouter.post('/sets/:id/cards', async (req, res) => {
  const s = await loadSet(req, req.params.id, 'edit');
  const bulk = Array.isArray(req.body.cards);
  const list = bulk ? req.body.cards : [req.body];
  if (!list.length || list.length > 5000) throw httpError(400, 'Between 1 and 5000 cards per request');
  let rows = list.map(cardInput);
  const existing = new Map((await db.all('SELECT id, front FROM cards WHERE set_id = ?', s.id)).map((c) => [dupKey(c.front), c.id]));
  let skipped = 0;
  if (!bulk && !req.body.force && existing.has(dupKey(rows[0].front))) {
    throw httpError(409, 'A card with this front already exists in the set', { code: 'duplicate', cardId: existing.get(dupKey(rows[0].front)) });
  }
  if (bulk && req.body.skipDuplicates) {
    const seen = new Set(existing.keys());
    rows = rows.filter((r) => { const k = dupKey(r.front); if (seen.has(k)) { skipped++; return false; } seen.add(k); return true; });
  }
  let pos = Number((await db.get('SELECT MAX(position) AS m FROM cards WHERE set_id = ?', s.id))?.m ?? -1);
  const ids = await db.tx(async (t) => {
    const out = [];
    for (const r of rows) {
      out.push((await t.get(`INSERT INTO cards (set_id, front, back, image, position, created_at, updated_at, type, notes, mnemonic, example, audio, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, s.id, r.front, r.back, r.image, ++pos, now(), now(), r.type, r.notes, r.mnemonic, r.example, r.audio, r.tags)).id);
    }
    return out;
  });
  res.json({ ids, skipped });
});

contentRouter.put('/cards/:id', async (req, res) => {
  const c = await loadCard(req, req.params.id, 'edit');
  const r = cardInput(req.body);
  await db.run('UPDATE cards SET front = ?, back = ?, image = ?, type = ?, notes = ?, mnemonic = ?, example = ?, audio = ?, tags = ?, updated_at = ? WHERE id = ?',
    r.front, r.back, r.image, r.type, r.notes, r.mnemonic, r.example, r.audio, r.tags, now(), c.id);
  // Drop progress for variants that no longer exist (e.g. a removed cloze number, or basic <-> cloze).
  const valid = r.type === 'cloze' ? clozeNumbers(r.front) : [0, 1];
  await db.run(`DELETE FROM progress WHERE card_id = ? AND variant NOT IN (${valid.map(Number).join(',')})`, c.id);
  res.json({ ok: true });
});

contentRouter.delete('/cards/:id', async (req, res) => {
  const c = await loadCard(req, req.params.id, 'edit');
  await db.run('DELETE FROM cards WHERE id = ?', c.id);
  res.json({ ok: true });
});

contentRouter.post('/cards/:id/star', async (req, res) => {
  const c = await loadCard(req, req.params.id);
  if (req.body.starred) await db.run('INSERT INTO stars (user_id, card_id) VALUES (?, ?) ON CONFLICT (user_id, card_id) DO NOTHING', req.user.id, c.id);
  else await db.run('DELETE FROM stars WHERE user_id = ? AND card_id = ?', req.user.id, c.id);
  res.json({ ok: true });
});

// Personal scheduling actions on all variants of a card: suspend / unsuspend / bury (until tomorrow) / reset / clear leech.
contentRouter.post('/cards/:id/schedule', async (req, res) => {
  const c = await loadCard(req, req.params.id);
  const action = String(req.body.action || '');
  const variants = variantsOf(c, c.set);
  const ensure = async () => {
    for (const v of variants) await db.run('INSERT INTO progress (user_id, card_id, variant) VALUES (?, ?, ?) ON CONFLICT (user_id, card_id, variant) DO NOTHING', req.user.id, c.id, v);
  };
  if (action === 'suspend') { await ensure(); await db.run('UPDATE progress SET suspended = 1 WHERE user_id = ? AND card_id = ?', req.user.id, c.id); }
  else if (action === 'unsuspend') await db.run('UPDATE progress SET suspended = 0, leech = 0 WHERE user_id = ? AND card_id = ?', req.user.id, c.id);
  else if (action === 'bury') {
    await ensure();
    const until = startOfDay(now(), await userTz(req.user.id)) + 86_400_000; // start of the user's tomorrow
    await db.run('UPDATE progress SET buried_until = ? WHERE user_id = ? AND card_id = ?', until, req.user.id, c.id);
  } else if (action === 'reset') await db.run('DELETE FROM progress WHERE user_id = ? AND card_id = ?', req.user.id, c.id);
  else throw httpError(400, 'Unknown action');
  res.json({ ok: true });
});

// Bulk actions on selected cards (all must be editable unless the action is personal).
const PERSONAL = new Set(['star', 'unstar', 'suspend', 'unsuspend']);
contentRouter.post('/cards/bulk', async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger))];
  const action = String(req.body.action || '');
  if (!ids.length || ids.length > 5000) throw httpError(400, 'Select between 1 and 5000 cards');
  const level = PERSONAL.has(action) ? 'read' : 'edit';
  const cards = [];
  for (const cid of ids) cards.push(await loadCard(req, cid, level)); // ponytail: N access checks; fine for UI-sized selections
  let target;
  if (action === 'move' || action === 'copy') target = await loadSet(req, req.body.setId, 'edit');
  const tag = action === 'tag' || action === 'untag' ? tagList(req.body.tag, 1)[0] : null;
  if ((action === 'tag' || action === 'untag') && !tag) throw httpError(400, 'Enter a tag');
  await db.tx(async (t) => {
    let pos = target ? Number((await t.get('SELECT MAX(position) AS m FROM cards WHERE set_id = ?', target.id))?.m ?? -1) : 0;
    for (const c of cards) {
      if (action === 'delete') await t.run('DELETE FROM cards WHERE id = ?', c.id);
      else if (action === 'move') await t.run('UPDATE cards SET set_id = ?, position = ? WHERE id = ?', target.id, ++pos, c.id);
      else if (action === 'copy') {
        await t.run(`INSERT INTO cards (set_id, front, back, image, position, created_at, updated_at, type, notes, mnemonic, example, audio, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, target.id, c.front, c.back, c.image, ++pos, now(), now(), c.type, c.notes, c.mnemonic, c.example, c.audio, c.tags);
      } else if (action === 'star') await t.run('INSERT INTO stars (user_id, card_id) VALUES (?, ?) ON CONFLICT (user_id, card_id) DO NOTHING', req.user.id, c.id);
      else if (action === 'unstar') await t.run('DELETE FROM stars WHERE user_id = ? AND card_id = ?', req.user.id, c.id);
      else if (action === 'suspend') {
        for (const v of variantsOf(c, c.set)) await t.run('INSERT INTO progress (user_id, card_id, variant) VALUES (?, ?, ?) ON CONFLICT (user_id, card_id, variant) DO NOTHING', req.user.id, c.id, v);
        await t.run('UPDATE progress SET suspended = 1 WHERE user_id = ? AND card_id = ?', req.user.id, c.id);
      } else if (action === 'unsuspend') await t.run('UPDATE progress SET suspended = 0, leech = 0 WHERE user_id = ? AND card_id = ?', req.user.id, c.id);
      else if (action === 'tag' || action === 'untag') {
        const tags = new Set(c.tags ? c.tags.split(',') : []);
        if (action === 'tag') tags.add(tag); else tags.delete(tag);
        await t.run('UPDATE cards SET tags = ? WHERE id = ?', [...tags].slice(0, 20).join(','), c.id);
      } else throw httpError(400, 'Unknown action');
    }
  });
  res.json({ ok: true, count: cards.length });
});

// ---------- Library: courses shared with the whole instance ----------
contentRouter.get('/library', async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
  const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const rows = await db.all(`SELECT c.id, c.title, c.icon, c.description, c.tags, c.visibility, c.owner_id, c.created_at, u.name AS owner_name,
      (SELECT COUNT(*) FROM sets s WHERE s.course_id = c.id) AS set_count,
      (SELECT COUNT(*) FROM cards k JOIN sets s ON s.id = k.set_id WHERE s.course_id = c.id) AS card_count,
      (SELECT COUNT(*) FROM saved_courses sc WHERE sc.course_id = c.id) AS learners,
      (SELECT 1 FROM saved_courses sc WHERE sc.course_id = c.id AND sc.user_id = ?) AS saved
    FROM courses c JOIN users u ON u.id = c.owner_id
    WHERE c.visibility = 'public' AND (? = '' OR LOWER(c.title) LIKE ? ESCAPE '\\' OR LOWER(c.tags) LIKE ? ESCAPE '\\' OR LOWER(c.description) LIKE ? ESCAPE '\\')
    ORDER BY learners DESC, c.created_at DESC LIMIT 200`, req.user.id, q, like, like, like);
  res.json(rows.map((r) => ({ ...r, owned: r.owner_id === req.user.id, saved: !!r.saved })));
});

// ---------- Search & tags ----------
contentRouter.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ courses: [], sets: [], cards: [] });
  const like = `%${q.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
  const R = readableParams(req.user);
  const [courses, sets, cards] = await Promise.all([
    db.all(`SELECT c.id, c.title, c.icon FROM courses c WHERE ${READABLE} AND (LOWER(c.title) LIKE ? ESCAPE '\\' OR LOWER(c.tags) LIKE ? ESCAPE '\\') ORDER BY c.title LIMIT 10`, ...R, like, like),
    db.all(`SELECT s.id, s.title, c.title AS course_title, c.icon FROM sets s JOIN courses c ON c.id = s.course_id WHERE ${READABLE} AND LOWER(s.title) LIKE ? ESCAPE '\\' ORDER BY s.title LIMIT 10`, ...R, like),
    db.all(`SELECT k.id, k.front, k.back, k.set_id, s.title AS set_title, c.icon FROM cards k JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id
      WHERE ${READABLE} AND (LOWER(k.front) LIKE ? ESCAPE '\\' OR LOWER(k.back) LIKE ? ESCAPE '\\' OR LOWER(k.tags) LIKE ? ESCAPE '\\') ORDER BY k.id DESC LIMIT 20`, ...R, like, like, like),
  ]);
  res.json({ courses, sets, cards });
});

contentRouter.get('/tags', async (req, res) => {
  const rows = await db.all(`SELECT k.tags FROM cards k JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id WHERE ${LISTED} AND k.tags <> ''`, ...listedParams(req.user));
  const counts = new Map();
  for (const r of rows) for (const t of r.tags.split(',')) counts.set(t, (counts.get(t) || 0) + 1);
  res.json([...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)));
});

export { dupKey, json };
