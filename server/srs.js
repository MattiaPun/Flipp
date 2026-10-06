// FSRS-inspired scheduler. Ratings: 1 Again, 2 Hard, 3 Good, 4 Easy.
// stability = days until recall probability drops to ~90%; difficulty in [1, 10].
const DAY = 86_400_000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function schedule(prev, rating, now = Date.now()) {
  const r = clamp(Math.round(rating), 1, 4);
  let S, D;
  if (!prev?.last_reviewed) {
    S = [0.4, 1.2, 3.2, 15.7][r - 1];
    D = clamp(5 - 1.5 * (r - 3), 1, 10);
  } else {
    const t = Math.max(0, (now - prev.last_reviewed) / DAY);
    const R = 1 / (1 + t / (9 * prev.stability)); // retrievability at review time
    D = clamp(0.9 * (prev.difficulty - 0.8 * (r - 3)) + 0.1 * 5, 1, 10); // with mean reversion
    S = r === 1
      ? Math.min(prev.stability, 1.9 * D ** -0.11 * ((prev.stability + 1) ** 0.29 - 1) * Math.exp(2.27 * (1 - R)))
      : prev.stability * (1 + Math.exp(1.6) * (11 - D) * prev.stability ** -0.15 * (Math.exp(1 - R) - 1) * (r === 2 ? 0.3 : 1) * (r === 4 ? 2 : 1));
  }
  S = clamp(S, 0.05, 36500);
  return {
    stability: S,
    difficulty: D,
    lapses: (prev?.lapses || 0) + (r === 1 ? 1 : 0),
    reps: (prev?.reps || 0) + 1,
    last_reviewed: now,
    next_due: now + (r === 1 ? 10 * 60_000 : Math.max(10 * 60_000, Math.round(S * DAY))),
  };
}

// Weakest first: most lapses, then lowest stability. New cards go after reviews.
export const weakFirst = (a, b) =>
  (a.last_reviewed == null) - (b.last_reviewed == null) || (b.lapses || 0) - (a.lapses || 0) || (a.stability || 0) - (b.stability || 0);
