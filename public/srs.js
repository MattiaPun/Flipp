// FSRS-6 scheduler with Anki-style learning steps. Shared by the server (authoritative) and the browser
// (interval previews on the rating buttons). Ratings: 1 Again, 2 Hard, 3 Good, 4 Easy.
// States: 0 new, 1 learning, 2 review, 3 relearning. Stability is in days; difficulty in [1, 10].

export const DEFAULT_W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

// Per-user, per-course knobs. Steps are in minutes.
export const DEFAULT_CONFIG = {
  retention: 0.9,
  steps: [1, 10],
  relearnSteps: [10],
  maxInterval: 36500,
  newPerDay: 20,
  reviewsPerDay: 200,
  leechThreshold: 8,
  leechAction: 'suspend', // 'suspend' | 'tag'
};

export const STATE = { NEW: 0, LEARNING: 1, REVIEW: 2, RELEARNING: 3 };
const DAY = 86_400_000, MIN = 60_000;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function normalizeConfig(c = {}) {
  const steps = (v, d) => (Array.isArray(v) ? v.map(Number).filter((n) => n > 0 && n < 1440 * 7).slice(0, 10) : d);
  return {
    retention: clamp(Number(c.retention) || DEFAULT_CONFIG.retention, 0.7, 0.99),
    steps: steps(c.steps, DEFAULT_CONFIG.steps),
    relearnSteps: steps(c.relearnSteps, DEFAULT_CONFIG.relearnSteps),
    maxInterval: clamp(Math.round(Number(c.maxInterval) || DEFAULT_CONFIG.maxInterval), 1, 36500),
    newPerDay: clamp(Math.round(Number(c.newPerDay ?? DEFAULT_CONFIG.newPerDay)), 0, 9999),
    reviewsPerDay: clamp(Math.round(Number(c.reviewsPerDay ?? DEFAULT_CONFIG.reviewsPerDay)), 0, 99999),
    leechThreshold: clamp(Math.round(Number(c.leechThreshold) || DEFAULT_CONFIG.leechThreshold), 2, 99),
    leechAction: c.leechAction === 'tag' ? 'tag' : 'suspend',
  };
}

export function model(w = DEFAULT_W) {
  if (!Array.isArray(w) || w.length !== 21 || !w.every(Number.isFinite)) w = DEFAULT_W;
  const decay = -w[20];
  const factor = 0.9 ** (1 / decay) - 1;
  const initD = (g) => w[4] - Math.exp(w[5] * (g - 1)) + 1;
  return {
    w,
    retrievability: (t, s) => (s > 0 ? (1 + (factor * t) / s) ** decay : 0),
    intervalDays: (s, r) => (s / factor) * (r ** (1 / decay) - 1),
    initS: (g) => Math.max(w[g - 1], 0.001),
    initD: (g) => clamp(initD(g), 1, 10),
    nextD: (d, g) => {
      const next = d + (-w[6] * (g - 3) * (10 - d)) / 9; // linear damping
      return clamp(w[7] * initD(4) + (1 - w[7]) * next, 1, 10); // mean reversion
    },
    recallS: (d, s, r, g) =>
      s * (1 + Math.exp(w[8]) * (11 - d) * s ** -w[9] * (Math.exp(w[10] * (1 - r)) - 1) * (g === 2 ? w[15] : 1) * (g === 4 ? w[16] : 1)),
    forgetS: (d, s, r) =>
      Math.min(w[11] * d ** -w[12] * ((s + 1) ** w[13] - 1) * Math.exp(w[14] * (1 - r)), s / Math.exp(w[17] * w[18])),
    shortTermS: (s, g) => {
      let inc = Math.exp(w[17] * (g - 3 + w[18])) * s ** -w[19];
      if (g >= 3) inc = Math.max(inc, 1);
      return s * inc;
    },
  };
}

// prev: progress row ({ state, step, stability, difficulty, lapses, reps, last_reviewed }) or null for a new card.
// Returns the next progress fields plus `lapsed` (true when a review card was forgotten).
export function schedule(prev, rating, now = Date.now(), { w, config } = {}) {
  const g = clamp(Math.round(rating), 1, 4);
  const m = model(w);
  const c = normalizeConfig(config);
  const state = prev?.last_reviewed ? prev.state ?? STATE.REVIEW : STATE.NEW;
  let { stability: s, difficulty: d } = prev || {};
  let step = prev?.step || 0;
  let lapses = prev?.lapses || 0;
  let next, nextState, lapsed = false;
  const reviewInterval = (stab) => clamp(Math.round(m.intervalDays(stab, c.retention)), 1, c.maxInterval) * DAY;

  // Learning-step logic shared by new, learning and relearning cards.
  const stepped = (steps, curStep) => {
    if (!steps.length || g === 4) return null; // graduate
    if (g === 1) return { step: 0, delay: steps[0] * MIN };
    if (g === 2) {
      const cur = steps[Math.min(curStep, steps.length - 1)];
      const nxt = steps[curStep + 1];
      return { step: curStep, delay: (curStep === 0 && nxt ? (cur + nxt) / 2 : cur * 1.5) * MIN };
    }
    return curStep + 1 < steps.length ? { step: curStep + 1, delay: steps[curStep + 1] * MIN } : null;
  };

  if (state === STATE.NEW) {
    s = m.initS(g);
    d = m.initD(g);
    const st = stepped(c.steps, 0);
    if (st) { nextState = STATE.LEARNING; step = st.step; next = now + st.delay; }
    else { nextState = STATE.REVIEW; step = 0; next = now + reviewInterval(s); }
  } else {
    const t = Math.max(0, (now - prev.last_reviewed) / DAY);
    const r = m.retrievability(t, s);
    d = m.nextD(d, g);
    if (state === STATE.REVIEW) {
      if (g === 1) {
        lapsed = true;
        lapses += 1;
        s = t < 1 ? m.shortTermS(s, g) : m.forgetS(prev.difficulty, s, r);
        if (c.relearnSteps.length) { nextState = STATE.RELEARNING; step = 0; next = now + c.relearnSteps[0] * MIN; }
        else { nextState = STATE.REVIEW; next = now + reviewInterval(s); }
      } else {
        s = t < 1 ? m.shortTermS(s, g) : m.recallS(prev.difficulty, s, r, g);
        nextState = STATE.REVIEW;
        next = now + reviewInterval(s);
      }
    } else {
      // learning / relearning: same-day short-term stability updates
      s = m.shortTermS(s, g);
      const st = stepped(state === STATE.LEARNING ? c.steps : c.relearnSteps, step);
      if (st) { nextState = state; step = st.step; next = now + st.delay; }
      else { nextState = STATE.REVIEW; step = 0; next = now + reviewInterval(s); }
    }
  }
  return {
    state: nextState,
    step,
    stability: clamp(s, 0.001, 36500),
    difficulty: clamp(d, 1, 10),
    lapses,
    reps: (prev?.reps || 0) + 1,
    last_reviewed: now,
    next_due: next,
    lapsed,
  };
}

// "10m", "5h", "3d", "2.5mo", "1.2y"
export function formatInterval(ms) {
  const m = ms / MIN;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  const days = m / 1440;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${+(days / 30).toFixed(1)}mo`;
  return `${+(days / 365).toFixed(1)}y`;
}

export const preview = (prev, now, opts) => [1, 2, 3, 4].map((g) => formatInterval(schedule(prev, g, now, opts).next_due - now));

// Weakest first: most lapses, then lowest stability. New cards go after reviews.
export const weakFirst = (a, b) =>
  (a.last_reviewed == null) - (b.last_reviewed == null) || (b.lapses || 0) - (a.lapses || 0) || (a.stability || 0) - (b.stability || 0);
