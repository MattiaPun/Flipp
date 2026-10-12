// Statistics: review heatmap, 30-day forecast, retention over time, card states, hardest cards; scheduler optimizer.
import { html, useState, useRef, useEffect } from '/vendor/htm-preact.js';
import { api, useAsync, useSubmit, toast, Md, fmtDate } from '/ui.js';
import { sides } from '/lib.js';

// Hover tooltip shared by the charts: { x, y, text } relative to the chart box.
function useTip() {
  const [tip, setTip] = useState(null);
  const show = (e, text) => {
    const box = e.currentTarget.closest('.chart').getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, text });
  };
  const el = tip && html`<div class="chart-tip" style=${{ left: Math.min(tip.x + 12, 9999) + 'px', top: tip.y - 36 + 'px' }}>${tip.text}</div>`;
  return { show, hide: () => setTip(null), el };
}

// Charts render at their real pixel width so axis text stays 10–11px on phones and desktops alike.
function useWidth(initial = 600) {
  const ref = useRef();
  const [w, setW] = useState(initial);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function TableToggle({ rows, cols }) {
  const [open, setOpen] = useState(false);
  return html`<div>
    <button class="btn ghost sm" onClick=${() => setOpen(!open)} aria-expanded=${open}>${open ? 'Hide table' : 'Show as table'}</button>
    ${open && html`<div class="scroll-x" style="max-height:240px;overflow:auto"><table class="list small"><thead><tr>${cols.map((c) => html`<th>${c}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${r.map((v) => html`<td>${v}</td>`)}</tr>`)}</tbody></table></div>`}
  </div>`;
}

function Heatmap({ days }) {
  const tip = useTip();
  const max = Math.max(1, ...days.map((d) => d.count));
  const level = (n) => (n === 0 ? 0 : Math.min(5, Math.ceil((n / max) * 5)));
  const first = new Date(days[0].date + 'T12:00:00');
  const offset = (first.getDay() + 6) % 7; // Monday-first rows
  const cell = 11, gap = 2;
  const weeks = Math.ceil((days.length + offset) / 7);
  const W = weeks * (cell + gap), H = 7 * (cell + gap);
  return html`<div class="chart" onMouseLeave=${tip.hide}>
    <svg viewBox=${`0 0 ${W} ${H}`} width="100%" role="img" aria-label=${`Reviews per day for the past year, up to ${max} per day`} style="max-width:${W * 1.4}px">
      ${days.map((d, i) => {
        const pos = i + offset;
        return html`<rect x=${Math.floor(pos / 7) * (cell + gap)} y=${(pos % 7) * (cell + gap)} width=${cell} height=${cell} rx="2" class=${`heat l${level(d.count)}`}
          onMouseMove=${(e) => tip.show(e, `${fmtDate(new Date(d.date + 'T12:00:00'))}: ${d.count} review${d.count === 1 ? '' : 's'}`)} />`;
      })}
    </svg>
    ${tip.el}
    <div class="row small faint" style="gap:4px;justify-content:flex-end;margin-top:6px">Less ${[0, 1, 2, 3, 4, 5].map((l) => html`<svg width="11" height="11" aria-hidden="true"><rect width="11" height="11" rx="2" class=${`heat l${l}`} /></svg>`)} More</div>
  </div>`;
}

function Bars({ data, label, fmt = (d) => d.date }) {
  const tip = useTip();
  const [ref, W] = useWidth();
  const max = Math.max(1, ...data.map((d) => d.count));
  const nice = Math.ceil(max / 5) * 5 || 5;
  const H = 160, L = 30, B = 20, bw = (W - L) / data.length;
  const ticks = [0, nice / 2, nice];
  const every = W < 420 ? 14 : 7;
  return html`<div class="chart" ref=${ref} onMouseLeave=${tip.hide}>
    <svg viewBox=${`0 0 ${W} ${H}`} width=${W} height=${H} role="img" aria-label=${label}>
      ${ticks.map((v) => { const y = H - B - (v / nice) * (H - B - 8); return html`<line x1=${L} x2=${W} y1=${y} y2=${y} class="grid" /><text x=${L - 6} y=${y + 3} class="axis" text-anchor="end">${v}</text>`; })}
      ${data.map((d, i) => {
        const h = (d.count / nice) * (H - B - 8);
        const x = L + i * bw + 1, w = Math.max(2, bw - 2);
        return html`<g onMouseMove=${(e) => tip.show(e, `${fmt(d)}: ${d.count}`)}>
          <rect x=${x - 1} y="0" width=${bw} height=${H - B} fill="transparent" />
          ${d.count > 0 && html`<path class="bar" d=${`M${x},${H - B} v${-Math.max(0, h - 4)} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${Math.max(0, h - 4)} z`} />`}
        </g>`;
      })}
      ${data.map((d, i) => (i % every === 0 ? html`<text x=${L + i * bw + bw / 2} y=${H - 5} class="axis" text-anchor="middle">${i === 0 ? 'Today' : `+${i}d`}</text>` : null))}
    </svg>
    ${tip.el}
  </div>`;
}

function RetentionLine({ weeks }) {
  const tip = useTip();
  const [ref, W] = useWidth();
  const H = 160, L = 34, B = 20, T = 8;
  const pts = weeks.map((w, i) => ({ ...w, x: L + (i / (weeks.length - 1)) * (W - L - 8), y: w.rate == null ? null : T + (1 - w.rate) * (H - B - T) }));
  let d = '';
  pts.forEach((p, i) => { if (p.y == null) return; d += `${i && pts[i - 1].y != null ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)} `; });
  const empty = !pts.some((p) => p.y != null);
  return html`<div class="chart" ref=${ref} onMouseLeave=${tip.hide}>
    ${empty && html`<div class="chart-empty">Not enough reviews yet. Retention shows up once cards come back for review.</div>`}
    <svg viewBox=${`0 0 ${W} ${H}`} width=${W} height=${H} role="img" aria-label="Share of due reviews you remembered, per week, last 26 weeks">
      ${[0, 0.5, 0.8, 1].map((v) => { const y = T + (1 - v) * (H - B - T); return html`<line x1=${L} x2=${W} y1=${y} y2=${y} class="grid" /><text x=${L - 6} y=${y + 3} class="axis" text-anchor="end">${v * 100}%</text>`; })}
      <path d=${d} class="line" />
      ${pts.map((p) => p.y != null && html`<g onMouseMove=${(e) => tip.show(e, `Week of ${fmtDate(p.start)}: ${Math.round(p.rate * 100)}% of ${p.total}`)}>
        <circle cx=${p.x} cy=${p.y} r="10" fill="transparent" /><circle cx=${p.x} cy=${p.y} r="4" class="dot" /></g>`)}
      <text x=${L} y=${H - 5} class="axis">26 weeks ago</text><text x=${W - 8} y=${H - 5} class="axis" text-anchor="end">This week</text>
    </svg>
    ${tip.el}
  </div>`;
}

export function Stats() {
  const { data: s, error } = useAsync(() => api('/stats/full'));
  if (error) return html`<p class="error">${error.message}</p>`;
  if (!s) return html`<div class="faint">Loading…</div>`;
  const tile = (n, label) => html`<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  return html`<div class="stack">
    <h1>Statistics</h1>
    <div class="stats four">
      ${tile(s.totals.reviews, 'reviews all time')}
      ${tile(s.retention30 == null ? '–' : `${Math.round(s.retention30 * 100)}%`, 'retention, 30 days')}
      ${tile(s.totals.activeDays, 'active days this year')}
      ${tile(s.totals.avgPerActiveDay, 'reviews per active day')}
    </div>
    <div class="panel col"><div class="section-title" style="margin:0">Activity</div>
      <${Heatmap} days=${s.heatmap} />
      <${TableToggle} cols=${['Date', 'Reviews']} rows=${s.heatmap.filter((d) => d.count).reverse().map((d) => [d.date, d.count])} /></div>
    <div class="panel col"><div class="section-title" style="margin:0">Due in the next 30 days</div>
      <${Bars} data=${s.forecast} label="Cards coming due per day for the next 30 days" fmt=${(d) => fmtDate(new Date(d.date + 'T12:00:00'))} />
      <${TableToggle} cols=${['Date', 'Cards due']} rows=${s.forecast.map((d) => [d.date, d.count])} /></div>
    <div class="panel col"><div class="section-title" style="margin:0">Retention</div>
      <p class="small muted">How often you remembered cards that were due for review. The scheduler aims for your target retention (90% by default).</p>
      <${RetentionLine} weeks=${s.retention} />
      <${TableToggle} cols=${['Week of', 'Reviews', 'Remembered']} rows=${s.retention.filter((w) => w.total).map((w) => [fmtDate(w.start), w.total, `${Math.round(w.rate * 100)}%`])} /></div>
    <div class="stats four">
      ${tile(s.counts.learning, 'learning')}${tile(s.counts.young, 'young (< 21 days)')}${tile(s.counts.mature, 'mature (≥ 21 days)')}${tile(s.counts.suspended, 'suspended')}
    </div>
    ${s.hardest.length > 0 && html`<div><div class="section-title">Hardest cards</div>
      <div class="panel" style="padding:0">${s.hardest.map((c) => { const x = sides(c, c.variant); return html`<a class="cardrow" href=${`#/set/${c.set_id}`}>
        <${Md} src=${x.prompt} /><${Md} class="back" src=${x.answer} /><span class="small" style="white-space:nowrap">${c.lapses} lapses</span></a>`; })}</div></div>`}
  </div>`;
}

export function Optimizer() {
  const info = useAsync(() => api('/account/optimizer'));
  const [run, st] = useSubmit(async () => {
    const r = await api('/account/optimizer', { method: 'POST' });
    toast(r.improved ? `Scheduler tuned to your memory (prediction error ${(r.before).toFixed(3)} → ${(r.after).toFixed(3)})` : 'Your current settings already fit well. Nothing changed.');
    info.reload();
  });
  const reset = async () => { await api('/account/optimizer', { method: 'DELETE' }); toast('Back to default parameters'); info.reload(); };
  const d = info.data;
  if (!d) return null;
  return html`<div class="panel col">
    <div class="section-title" style="margin:0">Personal scheduler</div>
    <p class="small muted">Fit the spaced-repetition model to your own review history so intervals match how you actually remember. Needs about ${d.minimum} reviews spread over several days.</p>
    <div class="row">
      <button class="btn sm" onClick=${run} disabled=${st.busy}>${st.busy ? 'Optimizing… (up to a minute)' : 'Optimize now'}</button>
      ${d.current && html`<span class="small muted">Tuned ${fmtDate(d.current.optimizedAt)} on ${d.current.reviews} reviews</span><button class="btn ghost sm" onClick=${reset}>Reset to defaults</button>`}
      ${!d.current && html`<span class="small faint">${d.reviews} reviews so far · using default parameters</span>`}
    </div>
    ${st.error && html`<p class="error">${st.error}</p>`}
  </div>`;
}
