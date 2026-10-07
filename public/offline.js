// Offline review queue: reviews that fail with a network error are kept in localStorage and replayed
// (with their original timestamps) when the connection comes back. Each entry carries the user id so a
// shared device never replays one person's reviews into another person's account.
import { api, toast } from '/ui.js';

const KEY = 'flipp.offlineReviews';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const save = (q) => { try { localStorage.setItem(KEY, JSON.stringify(q)); } catch {} dispatchEvent(new Event('flipp:offline-queue')); };

let uid = null;
const synced = new Map(); // ts -> reviewId of reviews flushed this page load, so undo still works after a sync
export const setOfflineUser = (id) => { uid = id ?? null; };
const mine = (r) => uid != null && r.uid === uid;

export const pendingCount = () => load().filter(mine).length;

export function queueReview(r) {
  save([...load(), { ...r, uid }]);
}

// Returns the server review id when the review was already synced (the caller then deletes it there).
export function unqueueReview(ts) {
  const q = load();
  if (q.some((r) => mine(r) && r.ts === ts)) { save(q.filter((r) => !(mine(r) && r.ts === ts))); return null; }
  return synced.get(ts) ?? null;
}

let flushing = false;
export async function flushReviews() {
  const q = load().filter(mine);
  if (!q.length || flushing || !navigator.onLine) return;
  flushing = true;
  const sent = (r) => mine(r) && q.some((x) => x.ts === r.ts && x.cardId === r.cardId);
  try {
    const { results } = await api('/review/batch', { method: 'POST', body: { reviews: q.map(({ uid: _, ...r }) => r) } });
    // The server sorts by ts, so match results back by position in the same order.
    const order = [...q].sort((a, b) => a.ts - b.ts);
    results.forEach((res, i) => { if (res.reviewId) synced.set(order[i].ts, res.reviewId); });
    // Drop everything the server processed (ok or permanently rejected); keep the queue on network errors.
    save(load().filter((r) => !sent(r)));
    const n = results.filter((r) => r.ok).length;
    if (n) toast(`Synced ${n} offline review${n === 1 ? '' : 's'}`);
  } catch (e) {
    if (e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status)) save(load().filter((r) => !sent(r))); // rejected outright: don't retry forever
  } finally {
    flushing = false;
  }
}

addEventListener('online', flushReviews);
