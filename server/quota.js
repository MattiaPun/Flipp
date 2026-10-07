// Per-user limits. Instance-wide defaults (settings.quota_defaults) can be overridden per user (users.quota).
// 0 / missing = unlimited. Admins are never limited. Card limits count cards in courses the user owns.
import { db, getJsonSetting } from './db.js';
import { httpError, json } from './util.js';

const KEYS = ['storageMb', 'courses', 'cards'];
export const cleanQuota = (q = {}) =>
  Object.fromEntries(KEYS.map((k) => [k, Math.max(0, Math.min(1e9, Math.round(Number(q[k]) || 0)))]));

export async function limitsFor(userId) {
  const u = await db.get('SELECT role, quota FROM users WHERE id = ?', userId);
  if (!u || u.role === 'admin') return cleanQuota({});
  const defaults = cleanQuota(await getJsonSetting('quota_defaults', {}));
  const own = json(u.quota, null);
  return own ? { ...defaults, ...Object.fromEntries(Object.entries(cleanQuota(own)).filter(([k]) => own[k] !== undefined && own[k] !== '')) } : defaults;
}

export async function usage(userId) {
  const [s, c, k] = await Promise.all([
    db.get('SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE user_id = ?', userId),
    db.get('SELECT COUNT(*) AS n FROM courses WHERE owner_id = ?', userId),
    db.get('SELECT COUNT(*) AS n FROM cards k JOIN sets s ON s.id = k.set_id JOIN courses c ON c.id = s.course_id WHERE c.owner_id = ?', userId),
  ]);
  return { storageBytes: Number(s.n), courses: Number(c.n), cards: Number(k.n) };
}

// Throws 403 if adding `add` units of `kind` would exceed the owner's limit.
export async function checkQuota(userId, kind, add = 1) {
  const limits = await limitsFor(userId);
  const limit = limits[kind];
  if (!limit) return;
  const u = await usage(userId);
  const current = kind === 'storageMb' ? u.storageBytes / 1048576 : u[kind];
  if (current + (kind === 'storageMb' ? add / 1048576 : add) > limit) {
    const label = { storageMb: `${limit} MB of storage`, courses: `${limit} courses`, cards: `${limit} cards` }[kind];
    throw httpError(403, `Quota reached: this account is limited to ${label}.`);
  }
}
