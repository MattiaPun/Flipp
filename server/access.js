// Who may read / edit / manage which course. Every content route goes through loadCourse/loadSet/loadCard.
// Inaccessible resources are reported as 404 so their existence is not leaked.
import { db } from './db.js';
import { httpError, id } from './util.js';

export const isAdmin = (u) => u?.role === 'admin';
export const isTeacher = (u) => u?.role === 'teacher' || u?.role === 'admin';

// SQL condition (course alias `c`) for courses the user can read. Use with ...readableParams(user).
export const READABLE = `(c.owner_id = ? OR c.visibility = 'public'
  OR EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?)
  OR EXISTS (SELECT 1 FROM group_courses gc JOIN group_members gm ON gm.group_id = gc.group_id WHERE gc.course_id = c.id AND gm.user_id = ?))`;
export const readableParams = (u) => [u.id, u.id, u.id];

// Courses that belong on the user's home screen: own, shared, assigned to one of their groups, or saved from the library.
export const LISTED = `(c.owner_id = ?
  OR EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = c.id AND cm.user_id = ?)
  OR EXISTS (SELECT 1 FROM group_courses gc JOIN group_members gm ON gm.group_id = gc.group_id WHERE gc.course_id = c.id AND gm.user_id = ?)
  OR (c.visibility = 'public' AND EXISTS (SELECT 1 FROM saved_courses sc WHERE sc.course_id = c.id AND sc.user_id = ?)))`;
export const listedParams = (u) => [u.id, u.id, u.id, u.id];

// Returns { role, canRead, canEdit, canManage } for a course row.
export async function courseAccess(user, c) {
  let role = null;
  if (c.owner_id === user.id) role = 'owner';
  else {
    const m = await db.get('SELECT role FROM course_members WHERE course_id = ? AND user_id = ?', c.id, user.id);
    if (m) role = m.role === 'editor' ? 'editor' : 'viewer';
    else if (await db.get('SELECT 1 AS ok FROM group_courses gc JOIN group_members gm ON gm.group_id = gc.group_id WHERE gc.course_id = ? AND gm.user_id = ?', c.id, user.id)) role = 'group';
    else if (c.visibility === 'public') role = 'public';
  }
  const admin = isAdmin(user);
  return {
    role: role || (admin ? 'admin' : null),
    canRead: !!role || admin,
    canEdit: role === 'owner' || role === 'editor' || admin,
    canManage: role === 'owner' || admin,
  };
}

const need = (access, level) => (level === 'manage' ? access.canManage : level === 'edit' ? access.canEdit : access.canRead);

export async function loadCourse(req, courseId, level = 'read') {
  const c = await db.get('SELECT * FROM courses WHERE id = ?', id(courseId));
  if (!c) throw httpError(404, 'Course not found');
  const access = await courseAccess(req.user, c);
  if (!need(access, level)) throw httpError(404, 'Course not found');
  return { ...c, ...access };
}

export async function loadSet(req, setId, level = 'read') {
  const s = await db.get('SELECT * FROM sets WHERE id = ?', id(setId));
  if (!s) throw httpError(404, 'Set not found');
  return { ...s, course: await loadCourse(req, s.course_id, level) };
}

export async function loadCard(req, cardId, level = 'read') {
  const c = await db.get('SELECT * FROM cards WHERE id = ?', id(cardId));
  if (!c) throw httpError(404, 'Card not found');
  return { ...c, set: await loadSet(req, c.set_id, level) };
}
