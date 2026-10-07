// Shared study helpers: card variants, due-SQL fragments, per-course config and per-user FSRS weights.
import { db } from './db.js';
import { json, now, dayKey } from './util.js';
import { normalizeConfig } from '../public/srs.js';
import { clozeNumbers } from '../public/lib.js';

// A progress row counts as due when it is scheduled, not suspended/buried and still a valid variant.
// Needs aliases p (progress), k (cards), s (sets). Params: [now, now].
export const DUE = `p.state > 0 AND p.suspended = 0 AND p.next_due <= ? AND (p.buried_until IS NULL OR p.buried_until <= ?)
  AND (p.variant = 0 OR k.type = 'cloze' OR s.reverse = 1)`;

// Scheduled variants of a card: basic -> 0 (+1 when the set studies reverse too); cloze -> each cloze number.
export function variantsOf(card, set) {
  if (card.type === 'cloze') return clozeNumbers(card.front);
  return set?.reverse ? [0, 1] : [0];
}

export async function courseConfig(userId, courseId) {
  const row = await db.get('SELECT prefs FROM course_prefs WHERE user_id = ? AND course_id = ?', userId, courseId);
  return normalizeConfig(json(row?.prefs, {}));
}

export async function userWeights(userId) {
  const row = await db.get('SELECT fsrs_params FROM users WHERE id = ?', userId);
  return json(row?.fsrs_params, null)?.w || null;
}

export async function userTz(userId) {
  const row = await db.get('SELECT prefs FROM users WHERE id = ?', userId);
  return json(row?.prefs, {}).tz || process.env.TZ || 'UTC';
}

export const MAX_FREEZES = 2;
const DAY = 86_400_000;

// Streak: consecutive local days with a review, XP or a freeze. With `spend`, a gap of missed days right
// before today is covered by held freezes when there are enough of them and the streak before the gap is alive.
export async function streakFor(userId, tz, { spend = false } = {}) {
  const t = now(), since = t - 400 * DAY;
  const days = new Set((await db.all('SELECT ts FROM reviews WHERE user_id = ? AND ts > ?', userId, since)).map((r) => dayKey(r.ts, tz)));
  for (const a of await db.all('SELECT day FROM activity WHERE user_id = ? AND day > ? AND (xp > 0 OR frozen = 1)', userId, dayKey(since, tz))) days.add(a.day);
  const key = (o) => dayKey(t - o * DAY, tz);
  if (spend) {
    let missed = 0;
    while (missed <= MAX_FREEZES && !days.has(key(missed + 1))) missed++;
    const held = missed > 0 && missed <= MAX_FREEZES && days.has(key(missed + 1)) ? Number((await db.get('SELECT freezes FROM users WHERE id = ?', userId)).freezes) : 0;
    if (missed > 0 && missed <= held) {
      const gap = Array.from({ length: missed }, (_, i) => key(i + 1));
      // Rows that already exist were spent by a concurrent request, so only newly inserted days are paid for.
      const ok = await db.tx(async (tx) => {
        let added = 0;
        for (const d of gap) added += (await tx.run('INSERT INTO activity (user_id, day, frozen) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO NOTHING', userId, d)).changes;
        if (added && !(await tx.run('UPDATE users SET freezes = freezes - ? WHERE id = ? AND freezes >= ?', added, userId, added)).changes) throw Object.assign(new Error('no freezes'), { quiet: true });
        return true;
      }).catch((e) => { if (e.quiet) return false; throw e; });
      if (ok) for (const d of gap) days.add(d);
    }
  }
  let streak = 0;
  for (let i = days.has(key(0)) ? 0 : 1; days.has(key(i)); i++) streak++;
  return { streak, days, today: key(0) };
}
