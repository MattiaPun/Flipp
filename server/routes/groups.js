// Study groups / classes: members, assigned courses, assignments with deadlines, teacher insights, weekly challenge.
// Privacy: teachers only see progress on courses assigned to their group; members are told so in the UI.
import crypto from 'node:crypto';
import { Router } from 'express';
import { db } from '../db.js';
import { httpError, id, now, str, startOfDay, zonedParts, dayKey, INSTANCE_TZ, email as emailField } from '../util.js';
import { loadCourse, isAdmin, isTeacher } from '../access.js';
import { audit } from '../audit.js';
import { userTz } from '../study-core.js';

export const groupsRouter = Router();
const DAY = 86_400_000;
const code = () => crypto.randomBytes(9).toString('base64url');

async function loadGroup(req, gid, level = 'member') {
  const g = await db.get('SELECT * FROM study_groups WHERE id = ?', id(gid));
  if (!g) throw httpError(404, 'Group not found');
  const m = await db.get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', g.id, req.user.id);
  const teacher = isAdmin(req.user) || m?.role === 'teacher';
  if (!m && !isAdmin(req.user)) throw httpError(404, 'Group not found');
  if (level === 'teacher' && !teacher) throw httpError(403, 'Only the group’s teachers can do that');
  return { ...g, myRole: m?.role || 'admin', teacher };
}

// Card ids covered by an assignment (whole course, or one set).
const scopeSql = (a) => (a.set_id ? ['k.set_id = ?', a.set_id] : ['s.course_id = ?', a.course_id]);

async function assignmentProgress(a, userIds) {
  const [where, param] = scopeSql(a);
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM cards k JOIN sets s ON s.id = k.set_id WHERE ${where}`, param)).n);
  const out = new Map(userIds.map((u) => [u, { studied: 0, mastered: 0 }]));
  if (!userIds.length || !total) return { total, byUser: out };
  const rows = await db.all(
    `SELECT p.user_id, COUNT(DISTINCT CASE WHEN p.state > 0 THEN p.card_id END) AS studied,
            COUNT(DISTINCT CASE WHEN p.state = 2 AND p.stability >= 21 THEN p.card_id END) AS mastered
     FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id
     WHERE ${where} AND p.user_id IN (${userIds.map(Number).join(',')}) GROUP BY p.user_id`, param);
  for (const r of rows) out.set(r.user_id, { studied: Number(r.studied), mastered: Number(r.mastered) });
  return { total, byUser: out };
}
const pct = (a, p, total) => (total ? Math.round(((a.goal === 'master' ? p.mastered : p.studied) / total) * 100) : 0);

groupsRouter.get('/groups', async (req, res) => {
  const rows = await db.all(`SELECT g.id, g.name, g.description, gm.role,
      (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS members,
      (SELECT COUNT(*) FROM assignments a WHERE a.group_id = g.id AND (a.due_at IS NULL OR a.due_at > ?)) AS open_assignments
    FROM study_groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? ORDER BY g.name`, now(), req.user.id);
  const all = isAdmin(req.user) ? await db.all(`SELECT g.id, g.name, (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS members FROM study_groups g ORDER BY g.name`) : [];
  res.json({ groups: rows, canCreate: isTeacher(req.user), all: all.filter((g) => !rows.some((r) => r.id === g.id)) });
});

groupsRouter.post('/groups', async (req, res) => {
  if (!isTeacher(req.user)) throw httpError(403, 'Only teachers and admins can create groups');
  const g = await db.get('INSERT INTO study_groups (name, description, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    str(req.body.name, 80, { min: 1 }), str(req.body.description ?? '', 1000), req.user.id, code(), now());
  await db.run("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'teacher', ?)", g.id, req.user.id, now());
  await audit(req, 'group.created', { target: `group:${g.id}` });
  res.json(g);
});

groupsRouter.post('/groups/join', async (req, res) => {
  const g = await db.get('SELECT id, name FROM study_groups WHERE invite_code = ?', String(req.body.code || ''));
  if (!g) throw httpError(404, 'This invite link is invalid or was reset');
  await db.run("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?) ON CONFLICT (group_id, user_id) DO NOTHING", g.id, req.user.id, now());
  await audit(req, 'group.joined', { target: `group:${g.id}` });
  res.json({ id: g.id, name: g.name });
});

groupsRouter.get('/groups/:id', async (req, res) => {
  const g = await loadGroup(req, req.params.id);
  const members = await db.all(`SELECT u.id, u.name, u.email, gm.role, gm.joined_at,
      (SELECT MAX(r.ts) FROM reviews r JOIN cards k ON k.id = r.card_id JOIN sets s ON s.id = k.set_id
        JOIN group_courses gc ON gc.course_id = s.course_id AND gc.group_id = gm.group_id WHERE r.user_id = u.id) AS last_review
    FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.role DESC, u.name`, g.id);
  const courses = await db.all(`SELECT c.id, c.title, c.icon, (SELECT COUNT(*) FROM cards k JOIN sets s ON s.id = k.set_id WHERE s.course_id = c.id) AS card_count
    FROM group_courses gc JOIN courses c ON c.id = gc.course_id WHERE gc.group_id = ? ORDER BY gc.added_at`, g.id);
  const assignments = await db.all(`SELECT a.*, c.title AS course_title, c.icon, s.title AS set_title FROM assignments a JOIN courses c ON c.id = a.course_id
    LEFT JOIN sets s ON s.id = a.set_id WHERE a.group_id = ? ORDER BY COALESCE(a.due_at, 9e15), a.id`, g.id);
  const studentIds = members.filter((m) => m.role === 'member').map((m) => m.id);
  for (const a of assignments) {
    const ids = g.teacher ? studentIds : [req.user.id];
    const p = await assignmentProgress(a, [...new Set([...ids, req.user.id])]);
    a.total = p.total;
    a.mine = pct(a, p.byUser.get(req.user.id), p.total);
    if (g.teacher) {
      a.students = studentIds.map((uid) => ({ id: uid, pct: pct(a, p.byUser.get(uid), p.total) }));
      a.done = a.students.filter((s) => s.pct >= 100).length;
    }
  }
  res.json({
    ...g, invite_code: g.teacher ? g.invite_code : undefined, courses, assignments,
    members: members.map((m) => ({ ...m, email: g.teacher ? m.email : undefined, last_review: g.teacher ? m.last_review : undefined })),
  });
});

groupsRouter.put('/groups/:id', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  await db.run('UPDATE study_groups SET name = ?, description = ? WHERE id = ?', str(req.body.name, 80, { min: 1 }), str(req.body.description ?? '', 1000), g.id);
  res.json({ ok: true });
});
groupsRouter.post('/groups/:id/code', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  const c = code();
  await db.run('UPDATE study_groups SET invite_code = ? WHERE id = ?', c, g.id);
  res.json({ invite_code: c });
});
groupsRouter.delete('/groups/:id', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  if (g.owner_id !== req.user.id && !isAdmin(req.user)) throw httpError(403, 'Only the group’s creator or an admin can delete it');
  await db.run('DELETE FROM study_groups WHERE id = ?', g.id);
  await audit(req, 'group.deleted', { target: `group:${g.id}`, details: { name: g.name } });
  res.json({ ok: true });
});

// ---------- Members ----------
groupsRouter.post('/groups/:id/members', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  const u = await db.get('SELECT id, role FROM users WHERE email = ?', emailField(req.body.email));
  if (!u) throw httpError(404, 'No user with that email on this instance');
  const role = req.body.role === 'teacher' ? 'teacher' : 'member';
  if (role === 'teacher' && !isTeacher(u)) throw httpError(400, 'Only users with the Teacher or Admin role can be group teachers');
  await db.run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT (group_id, user_id) DO UPDATE SET role = excluded.role', g.id, u.id, role, now());
  await audit(req, 'group.member_added', { target: `group:${g.id}`, details: { user: u.id, role } });
  res.json({ ok: true });
});
groupsRouter.delete('/groups/:id/members/:uid', async (req, res) => {
  const self = req.params.uid === 'me';
  const g = await loadGroup(req, req.params.id, self ? 'member' : 'teacher');
  const uid = self ? req.user.id : id(req.params.uid);
  const teachers = await db.all("SELECT user_id FROM group_members WHERE group_id = ? AND role = 'teacher'", g.id);
  if (teachers.length === 1 && teachers[0].user_id === uid) throw httpError(400, 'A group needs at least one teacher. Add another teacher first, or delete the group.');
  await db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', g.id, uid);
  await audit(req, 'group.member_removed', { target: `group:${g.id}`, details: { user: uid } });
  res.json({ ok: true });
});

// ---------- Courses & assignments ----------
groupsRouter.post('/groups/:id/courses', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  const c = await loadCourse(req, req.body.courseId);
  // Assigning grants every member read access, so the teacher must control the course (or it must already be public).
  if (!c.canManage && c.visibility !== 'public') throw httpError(403, 'You can only assign courses you own (or public ones)');
  await db.run('INSERT INTO group_courses (group_id, course_id, added_at) VALUES (?, ?, ?) ON CONFLICT (group_id, course_id) DO NOTHING', g.id, c.id, now());
  await audit(req, 'group.course_added', { target: `group:${g.id}`, details: { course: c.id } });
  res.json({ ok: true });
});
groupsRouter.delete('/groups/:id/courses/:cid', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  const cid = id(req.params.cid);
  await db.run('DELETE FROM assignments WHERE group_id = ? AND course_id = ?', g.id, cid);
  await db.run('DELETE FROM group_courses WHERE group_id = ? AND course_id = ?', g.id, cid);
  res.json({ ok: true });
});

groupsRouter.post('/groups/:id/assignments', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  const courseId = id(req.body.courseId);
  if (!(await db.get('SELECT 1 AS ok FROM group_courses WHERE group_id = ? AND course_id = ?', g.id, courseId))) throw httpError(400, 'Add the course to the group first');
  let setId = null;
  if (req.body.setId) {
    const s = await db.get('SELECT id FROM sets WHERE id = ? AND course_id = ?', id(req.body.setId), courseId);
    if (!s) throw httpError(400, 'That set is not in the course');
    setId = s.id;
  }
  const due = req.body.dueAt ? Math.round(Number(req.body.dueAt)) : null;
  if (due !== null && !(due > 0)) throw httpError(400, 'Invalid due date');
  const a = await db.get('INSERT INTO assignments (group_id, course_id, set_id, title, goal, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    g.id, courseId, setId, str(req.body.title, 120, { min: 1 }), req.body.goal === 'master' ? 'master' : 'study', due, req.user.id, now());
  res.json(a);
});
groupsRouter.delete('/groups/:id/assignments/:aid', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  await db.run('DELETE FROM assignments WHERE id = ? AND group_id = ?', id(req.params.aid), g.id);
  res.json({ ok: true });
});

// ---------- Teacher insights ----------
groupsRouter.get('/groups/:id/insights', async (req, res) => {
  const g = await loadGroup(req, req.params.id, 'teacher');
  const students = await db.all("SELECT u.id, u.name FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND gm.role = 'member'", g.id);
  const courseIds = (await db.all('SELECT course_id FROM group_courses WHERE group_id = ?', g.id)).map((r) => Number(r.course_id));
  if (!students.length || !courseIds.length) return res.json({ students: [], struggling: [] });
  const sIds = students.map((s) => Number(s.id)).join(','), cIds = courseIds.join(',');
  const t = now();
  // Only reviews on assigned courses are visible to teachers.
  const activity = await db.all(`SELECT r.user_id, COUNT(*) AS reviews_7d, SUM(CASE WHEN r.rating > 1 THEN 1 ELSE 0 END) AS passed_7d, MAX(r.ts) AS last
    FROM reviews r JOIN cards k ON k.id = r.card_id JOIN sets s ON s.id = k.set_id
    WHERE r.user_id IN (${sIds}) AND s.course_id IN (${cIds}) AND r.ts > ? GROUP BY r.user_id`, t - 7 * DAY);
  const lastEver = await db.all(`SELECT r.user_id, MAX(r.ts) AS last FROM reviews r JOIN cards k ON k.id = r.card_id JOIN sets s ON s.id = k.set_id
    WHERE r.user_id IN (${sIds}) AND s.course_id IN (${cIds}) GROUP BY r.user_id`);
  const byUser = new Map(activity.map((a) => [a.user_id, a]));
  const lastMap = new Map(lastEver.map((a) => [a.user_id, a.last]));
  const struggling = await db.all(`SELECT k.id, k.front, k.back, k.type, k.set_id, s.title AS set_title,
      COUNT(*) AS reviews, SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS fails, COUNT(DISTINCT r.user_id) AS learners
    FROM reviews r JOIN cards k ON k.id = r.card_id JOIN sets s ON s.id = k.set_id
    WHERE r.user_id IN (${sIds}) AND s.course_id IN (${cIds}) GROUP BY k.id, k.front, k.back, k.type, k.set_id, s.title
    HAVING COUNT(*) >= 3 ORDER BY SUM(CASE WHEN r.rating = 1 THEN 1.0 ELSE 0 END) / COUNT(*) DESC, COUNT(*) DESC LIMIT 15`);
  res.json({
    students: students.map((s) => {
      const a = byUser.get(s.id);
      return { ...s, reviews7d: Number(a?.reviews_7d || 0), accuracy7d: a?.reviews_7d ? Number(a.passed_7d) / Number(a.reviews_7d) : null, last: lastMap.get(s.id) || null };
    }),
    struggling: struggling.map((c) => ({ ...c, reviews: Number(c.reviews), fails: Number(c.fails), learners: Number(c.learners), failRate: Number(c.fails) / Number(c.reviews) })),
  });
});

// ---------- Weekly challenge (Mon–Sun in the instance timezone) ----------
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function weekStart(ts, tz = INSTANCE_TZ) {
  return startOfDay(ts, tz) - WEEKDAYS.indexOf(zonedParts(ts, tz).weekday) * DAY;
}

groupsRouter.get('/groups/:id/leaderboard', async (req, res) => {
  const g = await loadGroup(req, req.params.id);
  const start = weekStart(now());
  // Only reviews on the group's courses count: members' other studying stays private.
  const ON_GROUP = 'JOIN cards k ON k.id = r.card_id JOIN sets s ON s.id = k.set_id JOIN group_courses gc ON gc.course_id = s.course_id AND gc.group_id = ?';
  const rows = await db.all(`SELECT u.id, u.name, gm.role, (SELECT COUNT(*) FROM reviews r ${ON_GROUP} WHERE r.user_id = u.id AND r.ts >= ?) AS reviews
    FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY reviews DESC, u.name`, g.id, start, g.id);
  // Streaks: consecutive days with at least one review, in each member's own timezone.
  const out = [];
  for (const r of rows) {
    const tz = await userTz(r.id);
    const days = new Set((await db.all(`SELECT r.ts FROM reviews r ${ON_GROUP} WHERE r.user_id = ? AND r.ts > ?`, g.id, r.id, now() - 120 * DAY)).map((x) => dayKey(x.ts, tz)));
    let streak = 0;
    const key = (o) => dayKey(now() - o * DAY, tz);
    for (let i = days.has(key(0)) ? 0 : 1; days.has(key(i)); i++) streak++;
    out.push({ id: r.id, name: r.name, role: r.role, reviews: Number(r.reviews), streak, me: r.id === req.user.id });
  }
  res.json({ weekStart: start, weekEnd: start + 7 * DAY, timezone: INSTANCE_TZ, members: out });
});
