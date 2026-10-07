// Fits the 21 FSRS-6 weights to one user's review history by minimizing log-loss of predicted recall
// (Adam on finite-difference gradients, L2-regularized toward the defaults). Runs in a worker thread.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_W, model } from '../public/srs.js';

const DAY = 86_400_000;
export const BOUNDS = [
  [0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100], [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5],
  [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2], [0, 0.8], [0.1, 0.8],
];
export const MIN_REVIEWS = 400;
const clampW = (w) => w.map((x, i) => Math.min(BOUNDS[i][1], Math.max(BOUNDS[i][0], x)));

// sequences: [[{ ts, rating }, ...], ...] (one per card variant, time-ordered). Returns mean log-loss.
export function loss(w, sequences) {
  const m = model(w);
  let total = 0, n = 0;
  for (const seq of sequences) {
    let s = m.initS(seq[0].rating), d = m.initD(seq[0].rating), last = seq[0].ts;
    for (let i = 1; i < seq.length; i++) {
      const { ts, rating: g } = seq[i];
      const t = (ts - last) / DAY;
      if (t < 1) { s = m.shortTermS(s, g); d = m.nextD(d, g); last = ts; continue; }
      const r = Math.min(1 - 1e-6, Math.max(1e-6, m.retrievability(t, s)));
      const y = g > 1 ? 1 : 0;
      total -= y * Math.log(r) + (1 - y) * Math.log(1 - r);
      n++;
      s = g === 1 ? m.forgetS(d, s, r) : m.recallS(d, s, r, g);
      s = Math.min(36500, Math.max(0.001, s));
      d = m.nextD(d, g);
      last = ts;
    }
  }
  return n ? total / n : NaN;
}

export const countLongTerm = (sequences) => sequences.reduce((n, seq) => n + seq.slice(1).filter((r, i) => r.ts - seq[i].ts >= DAY).length, 0);

export function fit(sequences, { steps = 160, lr = 0.02, lambda = 0.02 } = {}) {
  let w = [...DEFAULT_W];
  const scale = BOUNDS.map(([lo, hi]) => Math.min(1, (hi - lo) / 10)); // per-parameter step scale
  const objective = (x) => loss(x, sequences) + lambda * x.reduce((acc, v, i) => acc + ((v - DEFAULT_W[i]) / (scale[i] * 10)) ** 2, 0) / x.length;
  const before = loss(DEFAULT_W, sequences);
  const m = Array(21).fill(0), v = Array(21).fill(0);
  let best = { w, obj: objective(w) };
  for (let step = 1; step <= steps; step++) {
    const grad = w.map((_, i) => {
      const h = scale[i] * 1e-3;
      const up = [...w]; up[i] += h;
      const dn = [...w]; dn[i] -= h;
      return (objective(clampW(up)) - objective(clampW(dn))) / (2 * h);
    });
    w = clampW(w.map((x, i) => {
      m[i] = 0.9 * m[i] + 0.1 * grad[i];
      v[i] = 0.999 * v[i] + 0.001 * grad[i] ** 2;
      const mh = m[i] / (1 - 0.9 ** step), vh = v[i] / (1 - 0.999 ** step);
      return x - lr * scale[i] * mh / (Math.sqrt(vh) + 1e-8);
    }));
    const obj = objective(w);
    if (Number.isFinite(obj) && obj < best.obj) best = { w, obj };
  }
  const after = loss(best.w, sequences);
  return { w: best.w.map((x) => +x.toFixed(4)), before, after, improved: after < before };
}

// Runs fit() in a worker so the event loop stays responsive.
export function fitInWorker(sequences, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { sequences, opts } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => code && reject(new Error(`optimizer exited with ${code}`)));
  });
}

if (!isMainThread && workerData?.sequences) parentPort.postMessage(fit(workerData.sequences, workerData.opts));
