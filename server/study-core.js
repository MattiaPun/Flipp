// Shared study helpers: card variants, due-SQL fragments, per-course config and per-user FSRS weights.
import { db } from './db.js';
import { json } from './util.js';
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
