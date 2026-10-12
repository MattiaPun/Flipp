// Study modes: Learn (spaced repetition), Flashcards, Write, Multiple choice and Cram.
import { html, useState, useEffect, useLayoutEffect, useRef, useMemo, useReducer } from '/vendor/htm-preact.js';
import { api, useAsync, toast, feedback, confetti, speak, Md, Icon, Illustration } from '/ui.js';
import { StudyQueue, grade, plain, shuffle, sides, charDiff, specialChars } from '/lib.js';
import { preview } from '/srs.js';
import { queueReview, unqueueReview, flushReviews } from '/offline.js';

export const MODES = {
  learn: { ico: 'repeat', title: 'Learn', sub: 'Spaced repetition', api: 'srs', records: true },
  flip: { ico: 'cards', title: 'Flashcards', sub: 'Flip & swipe', api: 'all', records: true },
  write: { ico: 'pencil', title: 'Write', sub: 'Type the answer', api: 'all', records: true },
  choice: { ico: 'list', title: 'Multiple choice', sub: 'Pick the answer', api: 'all', records: false },
  cram: { ico: 'bolt', title: 'Cram', sub: 'Weakest first, no schedule', api: 'cram', records: false },
};
// Modes where the card is answered (typed or picked) instead of flipped; they play their own sound on check.
const ANSWERED = new Set(['write', 'choice']);
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

// Entry: #/study?set=1|course=1|tag=x &mode=learn &dir=front|back|both &starred=1 &len=20 &min=10
export function Study({ query }) {
  const mode = MODES[query.mode] ? query.mode : 'learn';
  const scope = query.set ? `set=${query.set}` : query.course ? `course=${query.course}` : query.tag ? `tag=${encodeURIComponent(query.tag)}` : '';
  const back = query.set ? `#/set/${query.set}` : query.course ? `#/course/${query.course}` : query.tag ? `#/tags` : '#/';
  const dir = ['front', 'back', 'both'].includes(query.dir) ? query.dir : 'front';
  const { data, error, loading } = useAsync(
    () => api(`/study?${scope}&mode=${MODES[mode].api}&dir=${dir}&shuffle=1${query.starred === '1' ? '&starred=1' : ''}`),
    [scope, mode, dir, query.starred]);
  const [round, setRound] = useState({ n: 0, items: null });
  useEffect(() => { flushReviews(); }, []);
  // Stable identity: Session rebuilds its queue when `items` changes, so a fresh slice per render would reset it.
  const items = useMemo(() => {
    if (!data) return null;
    const len = Number(query.len) || 0;
    return round.items || (len > 0 ? data.items.slice(0, len) : data.items);
  }, [data, round.items, query.len]);

  if (loading) return html`<div class="study"><div class="faint">Loading…</div></div>`;
  if (error) return html`<div class="study"><p class="error">${error.message}</p><a class="btn" href=${back}>Back</a></div>`;
  if (!items.length) {
    return html`<div class="study pop empty-state">
      <${Illustration} />
      <h2>${mode === 'learn' ? 'All caught up' : 'No cards here yet'}</h2>
      <p class="muted">${mode === 'learn' ? 'Nothing is due right now. Come back later, or practice with another mode.' : query.starred === '1' ? 'Star some cards first.' : 'Add a few cards first.'}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <a class="btn" href=${back}>Back</a>
        ${mode === 'learn' && scope && html`<a class="btn primary" href=${`#/study?${scope}&mode=cram`}>Cram anyway</a>`}
      </div>
    </div>`;
  }
  const restart = (subset) => setRound({ n: round.n + 1, items: subset || null });
  const ctx = { w: data.w, configs: data.configs, back, mode, minutes: Number(query.min) || 0 };
  return html`<${Session} key=${round.n} items=${items} ctx=${ctx} restart=${restart} />`;
}

// Distractors for multiple choice: other answers in the pool with different text.
function choicesFor(item, pool) {
  const right = sides(item, item.variant).expected;
  const seen = new Set([plain(right).toLowerCase()]);
  const wrong = [];
  for (const o of shuffle(pool)) {
    const txt = sides(o, o.variant).expected;
    const k = plain(txt).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    wrong.push(txt);
    if (wrong.length === 3) break;
  }
  return shuffle([{ text: right, correct: true }, ...wrong.map((text) => ({ text, correct: false }))]);
}


function Session({ items, ctx, restart }) {
  const { mode } = ctx;
  const q = useMemo(() => new StudyQueue(items), [items]);
  const keys = useMemo(() => specialChars(items.map((i) => sides(i, i.variant).expected)), [items]);
  const [, tick] = useReducer((x) => x + 1, 0);
  const [flipped, setFlipped] = useState(false);
  const [started] = useState(Date.now());
  const [timeUp, setTimeUp] = useState(false);
  const [stars, setStars] = useState(() => new Map(items.map((c) => [c.id, !!c.starred])));
  const item = q.current;

  useEffect(() => {
    if (!ctx.minutes) return;
    const t = setTimeout(() => setTimeUp(true), ctx.minutes * 60_000);
    return () => clearTimeout(t);
  }, []);

  const flip = () => { setFlipped((f) => !f); feedback('flip'); };
  const rate = (r) => {
    const cur = q.current;
    if (!cur) return;
    let p = null;
    if (MODES[mode].records && cur.scheduled) {
      const review = { cardId: cur.id, variant: cur.variant, rating: r, ts: Date.now() };
      p = api('/review', { method: 'POST', body: review }).then((res) => {
        if (res.suspended) dropCard(cur.id);
        if (res.progress) cur.progress = res.progress; // later previews of this card in the session use the new state
        if (res.leech) toast(res.suspended ? 'Leech: this card keeps slipping, so it was suspended. Find it under Leeches.' : 'Leech: this card keeps slipping. Consider rewriting it.');
        return res;
      }, (e) => {
        if (e.offline) { queueReview(review); return { queued: review.ts }; }
        toast(e.message);
        return null;
      });
    }
    q.answer(r >= 3, { p, item: cur, progress: cur.progress });
    if (!ANSWERED.has(mode)) feedback(r >= 3 ? 'good' : 'bad');
    setFlipped(false);
    tick();
  };
  const undo = async () => {
    const meta = q.undo();
    if (!meta) return toast('Nothing to undo');
    meta.item.progress = meta.progress;
    setFlipped(false);
    tick();
    const res = await meta.p;
    const id = res?.queued ? unqueueReview(res.queued) : res?.reviewId;
    if (id) api(`/review/${res.reviewId}`, { method: 'DELETE' }).catch((e) => toast(e.message));
  };
  const toggleStar = (c) => {
    const on = !stars.get(c.id);
    setStars(new Map(stars).set(c.id, on));
    api(`/cards/${c.id}/star`, { method: 'POST', body: { starred: on } }).catch((e) => toast(e.message));
  };
  // Remove every variant of a card from the queue and from undo snapshots, so undo can't bring it back.
  const dropCard = (cardId) => {
    const keep = (k) => !String(k).startsWith(`${cardId}:`);
    q.q = q.q.filter(keep);
    for (const h of q.history) h.q = h.q.filter(keep);
    tick();
  };
  const scheduleAction = async (c, action) => {
    try {
      await api(`/cards/${c.id}/schedule`, { method: 'POST', body: { action } });
      toast(action === 'bury' ? 'Buried until tomorrow' : 'Card suspended');
      dropCard(c.id);
    } catch (e) { toast(e.message); }
  };

  // Layout effect, not effect: attached at commit, so a key pressed right as a card appears is never dropped.
  useLayoutEffect(() => {
    if (ANSWERED.has(mode)) return;
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || q.done || (timeUp && !flipped)) return;
      const k = e.key.toLowerCase();
      if (k === 'enter' && e.target.closest?.('a,button,summary')) return;
      if (k === ' ' || k === 'enter') { e.preventDefault(); flip(); }
      else if (k === 'z') undo();
      else if (k === 'arrowleft') rate(1);
      else if (k === 'arrowright') rate(3);
      else if ((mode === 'flip' || mode === 'cram') && k >= '1' && k <= '4') rate(k === '1' ? 1 : 3);
      else if (mode === 'learn' && k >= '1' && k <= '4' && flipped) rate(Number(k));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (q.done || (timeUp && !flipped)) return html`<${Summary} q=${q} started=${started} ctx=${ctx} restart=${restart} timeUp=${timeUp && !q.done} />`;
  const pct = (q.finished / q.total) * 100;
  const left = new Set(q.q).size;
  const isStarred = stars.get(item.id);
  const intervals = mode === 'learn' && item.scheduled ? preview(item.progress, Date.now(), { w: ctx.w, config: ctx.configs[item.course_id] }) : null;
  const k = item.key + ':' + q.history.length;
  const common = { item, starred: isStarred, onStar: () => toggleStar(item), onBury: item.scheduled ? () => scheduleAction(item, 'bury') : null, onSuspend: item.scheduled ? () => scheduleAction(item, 'suspend') : null };

  return html`<div class="study">
    <div class="study-head">
      <a class="btn ghost icon-btn" href=${ctx.back} title=${`Quit ${MODES[mode].title}`} aria-label=${`Quit ${MODES[mode].title}`}><${Icon} name="x" size=${22} /></a>
      <div class="progress" role="progressbar" aria-label="Session progress" aria-valuenow=${Math.round(pct)} aria-valuemin="0" aria-valuemax="100"><i style=${{ width: pct + '%' }} /></div>
      <button class="btn ghost icon-btn" onClick=${undo} disabled=${!q.history.length} title="Undo (Z)" aria-label="Undo"><${Icon} name="undo" /></button>
    </div>
    <span class="small muted" style="text-align:center;margin-top:-8px">${MODES[mode].title} · ${q.finished} / ${q.total} done · ${left} left${ctx.minutes ? html` · <${Countdown} until=${started + ctx.minutes * 60_000} />` : ''}</span>
    ${mode === 'choice' ? html`<${Choice} key=${k} ...${common} pool=${items} rate=${rate} undo=${undo} />`
      : mode === 'write' ? html`<${Write} key=${k} ...${common} keys=${keys} rate=${rate} undo=${undo} />`
      : html`
        <${Flashcard} key=${k} ...${common} flipped=${flipped} onFlip=${flip} onSwipe=${(d) => rate(d === 'right' ? 3 : 1)} />
        ${mode !== 'learn'
          ? html`<div class="rate two">
              <button class="btn again" onClick=${() => rate(1)}>Still learning<small>← swipe left</small></button>
              <button class="btn good" onClick=${() => rate(3)}>${mode === 'cram' ? 'Got it' : 'Mastered'}<small>swipe right →</small></button>
            </div>`
          : flipped
            ? html`<div class="rate pop">
                ${['Again', 'Hard', 'Good', 'Easy'].map((label, i) => html`<button class="btn ${label.toLowerCase()}" onClick=${() => rate(i + 1)}>
                  ${label}<small>${intervals ? intervals[i] : i + 1}</small></button>`)}
              </div>`
            : html`<button class="btn primary lg" onClick=${flip}>Show answer</button>`}
        <div class="keys"><span><kbd>Space</kbd> flip</span><span><kbd>1</kbd>–<kbd>4</kbd> / <kbd>←</kbd><kbd>→</kbd> rate</span><span><kbd>Z</kbd> undo</span></div>`}
  </div>`;
}

function Countdown({ until }) {
  const [, tick] = useReducer((x) => x + 1, 0);
  useEffect(() => { const t = setInterval(tick, 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  return html`<span class="mono">${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}</span>`;
}

function CardTools({ item, text, starred, onStar, onBury, onSuspend }) {
  const audio = useRef();
  return html`<div class="tools">
    ${item.audio && html`<button class="btn ghost icon-btn" title="Play audio" aria-label="Play audio" onClick=${() => { audio.current.currentTime = 0; audio.current.play(); }}><${Icon} name="play" /></button><audio ref=${audio} src=${item.audio} preload="none" />`}
    <button class="btn ghost icon-btn" title="Speak" aria-label="Speak" onClick=${() => speak(text, item.lang)}><${Icon} name="speaker" /></button>
    ${onStar && html`<button class="btn ghost icon-btn star ${starred ? 'on' : ''}" title="Star" aria-label="Star" aria-pressed=${!!starred} onClick=${onStar}><${Icon} name="star" fill=${starred} /></button>`}
    ${(onBury || onSuspend) && html`<details class="menu"><summary class="btn ghost icon-btn" aria-label="More">⋯</summary><div class="menu-list">
      ${onBury && html`<button onClick=${onBury}>Bury until tomorrow</button>`}
      ${onSuspend && html`<button onClick=${onSuspend}>Suspend card</button>`}
      <a href=${`#/set/${item.set_id}`}>Open set</a>
    </div></details>`}
  </div>`;
}

const Extras = ({ item }) => (item.notes || item.mnemonic || item.example || (item.type === 'cloze' && item.back))
  ? html`<div class="extras">
      ${item.type === 'cloze' && item.back && html`<${Md} src=${item.back} />`}
      ${item.mnemonic && html`<div><span class="extra-label">Mnemonic</span><${Md} src=${item.mnemonic} /></div>`}
      ${item.example && html`<div><span class="extra-label">Example</span><${Md} src=${item.example} /></div>`}
      ${item.notes && html`<div><span class="extra-label">Notes</span><${Md} src=${item.notes} /></div>`}
    </div>`
  : null;

export function Flashcard({ item, flipped, onFlip, onSwipe, ...tools }) {
  const el = useRef(), hintL = useRef(), hintR = useRef(), drag = useRef(null);
  const { prompt, answer } = sides(item, item.variant);
  const setHints = (dx) => { hintL.current.style.opacity = Math.min(1, Math.max(0, -dx / 90)); hintR.current.style.opacity = Math.min(1, Math.max(0, dx / 90)); };
  // Pointer-driven swipe: transforms are written straight to the DOM (no re-render) to stay at 60fps.
  const down = (e) => {
    if (e.target.closest('button, a, summary, audio, .menu-list') || e.button > 0) return;
    drag.current = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, id: e.pointerId };
    el.current.classList.remove('snap');
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.x; d.dy = e.clientY - d.y;
    if (Math.abs(d.dx) > 8 && !el.current.hasPointerCapture(d.id)) el.current.setPointerCapture(d.id);
    el.current.style.transform = `translateX(${d.dx}px) rotate(${d.dx / 24}deg)`;
    setHints(d.dx);
  };
  const up = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const node = el.current;
    node.classList.add('snap');
    setHints(0);
    if (e.type !== 'pointercancel' && Math.abs(d.dx) > 90) {
      const dir = Math.sign(d.dx);
      node.style.transform = `translateX(${dir * (innerWidth + 100)}px) rotate(${dir * 18}deg)`;
      node.style.opacity = '0';
      setTimeout(() => onSwipe(dir > 0 ? 'right' : 'left'), 160);
    } else {
      node.style.transform = '';
      if (e.type !== 'pointercancel' && Math.abs(d.dx) < 6 && Math.abs(d.dy) < 6) onFlip();
    }
  };
  const label = item.type === 'cloze' ? ['Cloze', 'Answer'] : item.variant === 1 ? ['Definition', 'Term'] : ['Term', 'Definition'];
  return html`<div class="stage pop ${flipped ? 'flipped' : ''}">
    <div class="swipe" ref=${el} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>
      <div class="card3d">
        <div class="face front"><span class="corner">${label[0]}</span><${CardTools} item=${item} text=${prompt} ...${tools} />
          ${item.image && item.variant !== 1 && html`<img src=${item.image} alt="" draggable="false" />`}<${Md} src=${prompt} /></div>
        <div class="face back"><span class="corner">${label[1]}</span><${CardTools} item=${item} text=${answer} ...${tools} />
          ${item.image && item.variant === 1 && html`<img src=${item.image} alt="" draggable="false" />`}<${Md} src=${answer} /><${Extras} item=${item} /></div>
      </div>
      <div class="hint left" ref=${hintL}>Still learning</div>
      <div class="hint right" ref=${hintR}>Mastered</div>
    </div>
  </div>`;
}

function Prompt({ item, ...tools }) {
  const { prompt } = sides(item, item.variant);
  return html`<div class="face static">
    <span class="corner">${item.type === 'cloze' ? 'Fill in the blank' : item.variant === 1 ? 'Definition' : 'Term'}</span>
    <${CardTools} item=${item} text=${prompt} ...${tools} />
    ${item.image && html`<img src=${item.image} alt="" />`}
    <${Md} src=${prompt} />
  </div>`;
}

// Typed answers, graded with typo and accent tolerance.
function Write({ item, rate, undo, keys = [], ...tools }) {
  const { answer, expected } = sides(item, item.variant);
  const [input, setInput] = useState('');
  const [hints, setHints] = useState(0);
  const [result, setResult] = useState(null);
  const ref = useRef();
  const target = plain(expected);
  useEffect(() => { ref.current?.focus(); }, []);
  const check = (giveUp) => {
    const g = giveUp ? 'wrong' : grade(input, expected);
    setResult(g);
    feedback(g === 'wrong' ? 'bad' : 'good');
  };
  const hint = () => {
    const n = Math.min(target.length, hints + 1);
    setHints(n);
    setInput(target.slice(0, n));
    ref.current?.focus();
  };
  // Tap-to-insert keys for letters the keyboard may not have; the caret stays where it was.
  const insert = (ch) => {
    const el = ref.current, a = el.selectionStart ?? input.length, b = el.selectionEnd ?? input.length;
    setInput(input.slice(0, a) + ch + input.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + ch.length, a + ch.length); });
  };
  // A correct answer that needed hints counts as "Hard", so it comes back sooner.
  const ratingFor = (g) => (g === 'wrong' ? 1 : hints > 0 ? 2 : 3);
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (!result) return;
      if (e.key === 'Enter') { e.preventDefault(); rate(ratingFor(result)); }
      else if (e.key.toLowerCase() === 'z' && !isTyping(e)) undo();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  return html`<div class="col pop">
    <${Prompt} item=${item} ...${tools} />
    ${!result
      ? html`<form class="col" onSubmit=${(e) => { e.preventDefault(); check(false); }}>
          <input class="input answer-input" ref=${ref} placeholder="Type the answer…" value=${input} onInput=${(e) => setInput(e.target.value)}
            autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Your answer" />
          ${keys.length > 0 && html`<div class="char-keys" aria-label="Insert a letter">${keys.map((ch) => html`<button type="button" class="btn sm" onPointerDown=${(e) => e.preventDefault()} onClick=${() => insert(ch)}>${ch}</button>`)}</div>`}
          <div class="row">
            <button class="btn primary grow" type="submit">Check <kbd>↵</kbd></button>
            <button class="btn ghost" type="button" onClick=${hint} disabled=${hints >= target.length}>Hint${hints ? ` (${hints})` : ''}</button>
            <button class="btn ghost" type="button" onClick=${() => check(true)}>Don't know</button>
          </div>
        </form>`
      : html`<div class="result pop ${result === 'exact' ? 'ok' : result === 'close' ? 'close' : 'bad'}">
          <div class="result-title">${result === 'exact' ? (hints ? 'Correct, with hints' : 'Correct') : result === 'close' ? 'Almost. Check the spelling' : input ? 'Incorrect' : 'The answer'}</div>
          ${input && result !== 'exact' && html`<div class="small muted">You wrote:</div>
            <div class="diff" aria-label="Your answer compared to the correct one">${charDiff(input, target).map((d) => html`<span class=${d.op}>${d.ch}</span>`)}</div>`}
          ${result !== 'exact' && html`<div class="small muted">Correct answer:</div>`}
          <${Md} src=${answer} />
          <${Extras} item=${item} />
        </div>
        <div class="row">
          <button class="btn lg grow ${result === 'wrong' ? 'again' : 'good'}" onClick=${() => rate(ratingFor(result))}>Continue <kbd>↵</kbd></button>
          ${result === 'wrong' && html`<button class="btn" onClick=${() => rate(3)}>I was right</button>`}
        </div>`}
  </div>`;
}

function Choice({ item, pool, rate, undo, ...tools }) {
  const options = useMemo(() => choicesFor(item, pool), [item.key]);
  const [picked, setPicked] = useState(null);
  const { answer } = sides(item, item.variant);
  const pick = (i) => {
    if (picked !== null) return;
    setPicked(i);
    feedback(options[i].correct ? 'good' : 'bad');
  };
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      if (picked === null && e.key >= '1' && e.key <= String(options.length)) pick(Number(e.key) - 1);
      else if (picked !== null && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); rate(options[picked].correct ? 3 : 1); }
      else if (e.key.toLowerCase() === 'z') undo();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  if (options.length < 2) return html`<div class="col"><${Prompt} item=${item} ...${tools} /><p class="muted">Not enough different answers in this set for multiple choice.</p><button class="btn" onClick=${() => rate(3)}>Skip</button></div>`;
  return html`<div class="col pop">
    <${Prompt} item=${item} ...${tools} />
    <div class="choices">${options.map((o, i) => html`<button class="choice ${picked !== null && o.correct ? 'right' : ''} ${picked === i && !o.correct ? 'wrong' : ''}" onClick=${() => pick(i)} disabled=${picked !== null && picked !== i && !o.correct}>
      <kbd>${i + 1}</kbd><${Md} src=${o.text} /></button>`)}</div>
    ${picked !== null && html`<div class="col pop">
      ${options[picked].correct
        ? html`<div class="result ok"><div class="result-title" style="margin:0">Correct</div></div>`
        : html`<div class="result bad"><div class="result-title">Incorrect</div><div class="small muted">Correct answer:</div><${Md} src=${answer} /><${Extras} item=${item} /></div>`}
      <button class="btn lg ${options[picked].correct ? 'good' : 'again'}" onClick=${() => rate(options[picked].correct ? 3 : 1)}>Continue <kbd>↵</kbd></button></div>`}
  </div>`;
}

function Summary({ q, started, ctx, restart, timeUp }) {
  const answered = [...q.firstTry.keys()];
  const firstTry = [...q.firstTry.values()].filter(Boolean).length;
  const { data: stats } = useAsync(() => api('/stats').catch(() => null));
  const missed = [...q.miss].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ item: q.cards.get(id), n }));
  const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
  const acc = answered.length ? Math.round((firstTry / answered.length) * 100) : 0;
  // Confetti only for a genuinely strong session, so it still means something.
  useEffect(() => { feedback('win'); if (!timeUp && answered.length >= 5 && acc >= 90) confetti(); }, []);
  return html`<div class="study pop">
    <div class="celebrate">
      <h1>${timeUp ? "Time's up" : 'Session complete'}</h1>
      ${stats && html`<p class="muted" style="margin-top:6px">${stats.today} reviews today${stats.streak ? ` · ${stats.streak}-day streak` : ''}</p>`}
      ${stats?.freezeEarned && html`<p class="small" style="margin-top:6px"><${Icon} name="snow" size=${14} /> ${stats.streak}-day streak: you earned a streak freeze. It covers a day you miss.</p>`}</div>
    <div class="stats">
      <div class="stat"><b><${Icon} name="cards" size=${22} />${answered.length}</b><span>cards</span></div>
      <div class="stat"><b><${Icon} name="target" size=${22} />${acc}%</b><span>right first time</span></div>
      <div class="stat"><b><${Icon} name="clock" size=${22} />${mins}m</b><span>time</span></div>
    </div>
    ${missed.length > 0 && html`<div>
      <div class="section-title">Needs more practice</div>
      <div class="panel" style="padding:0">${missed.map(({ item, n }) => { const s = sides(item, item.variant); return html`<div class="cardrow">
        <${Md} src=${s.prompt} /><${Md} class="back" src=${s.answer} /><span class="small" style="color:var(--bad)">missed ${n}×</span></div>`; })}</div>
    </div>`}
    <div class="row">
      ${missed.length > 0 && html`<button class="btn primary lg" onClick=${() => restart(missed.map((m) => m.item))}>Practice missed (${missed.length})</button>`}
      ${ctx.mode !== 'learn' && html`<button class=${`btn ${missed.length ? '' : 'primary lg'}`} onClick=${() => restart()}>Study again</button>`}
      <a class="btn ghost" href=${ctx.back}>Done</a>
    </div>
  </div>`;
}
