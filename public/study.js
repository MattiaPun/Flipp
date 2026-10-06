import { html, useState, useEffect, useRef, useMemo, useReducer } from '/vendor/htm-preact.js';
import { api, useAsync, toast, feedback, speak, Md, Icon } from '/ui.js';
import { StudyQueue, grade, plain, shuffle } from '/lib.js';

const MODES = { learn: 'Learn', flip: 'Flashcards', write: 'Write', match: 'Match' };
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

// Entry: #/study?set=1&mode=learn&starred=1   (or course=, or no scope = all due cards)
export function Study({ query }) {
  const mode = MODES[query.mode] ? query.mode : 'learn';
  const scope = query.set ? `set=${query.set}` : query.course ? `course=${query.course}` : '';
  const back = query.set ? `#/set/${query.set}` : query.course ? `#/course/${query.course}` : '#/';
  const { data, error, loading } = useAsync(
    () => api(`/study?${scope}&mode=${mode === 'learn' ? 'srs' : 'all'}&shuffle=1${query.starred === '1' ? '&starred=1' : ''}`),
    [scope, mode, query.starred]);
  const [round, setRound] = useState({ n: 0, cards: null });
  const cards = round.cards || data;

  if (loading) return html`<div class="study"><div class="faint">Loading…</div></div>`;
  if (error) return html`<div class="study"><p class="error">${error.message}</p><a class="btn" href=${back}>Back</a></div>`;
  if (!cards.length) {
    return html`<div class="study pop" style="text-align:center;padding-top:10vh">
      <div style="font-size:42px">✓</div>
      <h2>${mode === 'learn' ? 'All caught up' : 'No cards here yet'}</h2>
      <p class="muted">${mode === 'learn' ? 'Nothing is due right now. Come back later, or practice with another mode.' : query.starred === '1' ? 'Star some cards first.' : 'Add a few cards to this set.'}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <a class="btn" href=${back}>Back</a>
        ${mode === 'learn' && scope && html`<a class="btn primary" href=${`#/study?${scope}&mode=flip`}>Flashcards</a>`}
      </div>
    </div>`;
  }
  if (mode === 'match') return html`<${Match} key=${round.n} setId=${query.set} cards=${cards} back=${back} restart=${() => setRound({ n: round.n + 1, cards: null })} />`;
  return html`<${Session} key=${round.n} cards=${cards} mode=${mode} back=${back}
    restart=${(subset) => setRound({ n: round.n + 1, cards: subset || null })} />`;
}

function Session({ cards, mode, back, restart }) {
  const q = useMemo(() => new StudyQueue(cards), [cards]);
  const [, tick] = useReducer((x) => x + 1, 0);
  const [flipped, setFlipped] = useState(false);
  const [started] = useState(Date.now());
  const [stars, setStars] = useState(() => new Map(cards.map((c) => [c.id, !!c.starred])));
  const card = q.current;

  const flip = () => { setFlipped((f) => !f); feedback('flip'); };
  const rate = (r) => {
    if (!q.current) return;
    const p = api('/review', { method: 'POST', body: { cardId: q.current.id, rating: r } }).catch((e) => toast(e.message));
    q.answer(r >= 3, { p });
    feedback(r >= 3 ? 'good' : 'bad');
    setFlipped(false);
    tick();
  };
  const undo = async () => {
    const meta = q.undo();
    if (!meta) return toast('Nothing to undo');
    setFlipped(false);
    tick();
    const res = await meta.p;
    if (res?.reviewId) api(`/review/${res.reviewId}`, { method: 'DELETE' }).catch((e) => toast(e.message));
  };
  const toggleStar = (c) => {
    const on = !stars.get(c.id);
    setStars(new Map(stars).set(c.id, on));
    api(`/cards/${c.id}/star`, { method: 'POST', body: { starred: on } }).catch((e) => toast(e.message));
  };

  // Keyboard: Space flip · 1–4 / ← → rate · Z undo (iPad Magic Keyboard + desktop)
  useEffect(() => {
    if (mode === 'write') return;
    const onKey = (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || q.done) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'enter') { e.preventDefault(); flip(); }
      else if (k === 'z') undo();
      else if (k === 'arrowleft') rate(1);
      else if (k === 'arrowright') rate(3);
      else if (mode === 'flip' && k >= '1' && k <= '4') rate(k === '1' ? 1 : 3);
      else if (mode === 'learn' && k >= '1' && k <= '4' && flipped) rate(Number(k));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (q.done) return html`<${Summary} q=${q} started=${started} back=${back} restart=${restart} />`;
  const pct = (q.finished / q.total) * 100;
  const left = new Set(q.q).size;
  const isStarred = stars.get(card.id);

  return html`<div class="study">
    <div class="row between">
      <a class="btn ghost sm" href=${back}><${Icon} name="x" /> ${MODES[mode]}</a>
      <span class="small muted">${q.finished} / ${q.total} · ${left} left</span>
      <button class="btn ghost sm" onClick=${undo} disabled=${!q.history.length} title="Undo (Z)"><${Icon} name="undo" /></button>
    </div>
    <div class="progress"><i style=${{ width: pct + '%' }} /></div>
    ${mode === 'write'
      ? html`<${Write} key=${card.id + ':' + q.history.length} card=${card} rate=${rate} undo=${undo} starred=${isStarred} onStar=${() => toggleStar(card)} />`
      : html`
        <${Flashcard} key=${card.id + ':' + q.history.length} card=${card} flipped=${flipped} onFlip=${flip}
          onSwipe=${(dir) => rate(dir === 'right' ? 3 : 1)} starred=${isStarred} onStar=${() => toggleStar(card)} />
        ${mode === 'flip'
          ? html`<div class="rate two">
              <button class="btn again" onClick=${() => rate(1)}>Still learning<small>← swipe left</small></button>
              <button class="btn good" onClick=${() => rate(3)}>Mastered<small>swipe right →</small></button>
            </div>`
          : flipped
            ? html`<div class="rate pop">
                <button class="btn again" onClick=${() => rate(1)}>Again<small>1</small></button>
                <button class="btn hard" onClick=${() => rate(2)}>Hard<small>2</small></button>
                <button class="btn good" onClick=${() => rate(3)}>Good<small>3</small></button>
                <button class="btn easy" onClick=${() => rate(4)}>Easy<small>4</small></button>
              </div>`
            : html`<button class="btn primary lg" onClick=${flip}>Show answer</button>`}
        <div class="keys"><span><kbd>Space</kbd> flip</span><span><kbd>1</kbd>–<kbd>4</kbd> / <kbd>←</kbd><kbd>→</kbd> rate</span><span><kbd>Z</kbd> undo</span></div>`}
  </div>`;
}

export function Flashcard({ card, flipped, onFlip, onSwipe, starred, onStar }) {
  const el = useRef(), hintL = useRef(), hintR = useRef(), drag = useRef(null);
  const setHints = (dx) => { hintL.current.style.opacity = Math.min(1, Math.max(0, -dx / 90)); hintR.current.style.opacity = Math.min(1, Math.max(0, dx / 90)); };
  // Pointer-driven swipe: transforms are written straight to the DOM (no re-render) to stay at 60fps.
  const down = (e) => {
    if (e.target.closest('button') || e.button > 0) return;
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
  const tools = (text) => html`<div class="tools">
    <button class="btn ghost icon-btn" title="Speak" onClick=${() => speak(text, card.lang)}><${Icon} name="speaker" /></button>
    ${onStar && html`<button class="btn ghost icon-btn star ${starred ? 'on' : ''}" title="Star" onClick=${onStar}><${Icon} name="star" fill=${starred} /></button>`}
  </div>`;
  return html`<div class="stage pop ${flipped ? 'flipped' : ''}">
    <div class="swipe" ref=${el} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>
      <div class="card3d">
        <div class="face front"><span class="corner">Term</span>${tools(card.front)}
          ${card.image && html`<img src=${card.image} alt="" draggable="false" />`}<${Md} src=${card.front} /></div>
        <div class="face back"><span class="corner">Definition</span>${tools(card.back)}<${Md} src=${card.back} /></div>
      </div>
      <div class="hint left" ref=${hintL}>Still learning</div>
      <div class="hint right" ref=${hintR}>Mastered</div>
    </div>
  </div>`;
}

function Write({ card, rate, undo, starred, onStar }) {
  const [input, setInput] = useState('');
  const [result, setResult] = useState(null);
  const ref = useRef();
  useEffect(() => ref.current?.focus(), []);
  const check = (giveUp) => {
    const g = giveUp ? 'wrong' : grade(input, card.back);
    setResult(g);
    feedback(g === 'wrong' ? 'bad' : 'good');
  };
  useEffect(() => {
    if (!result) return;
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); rate(result === 'wrong' ? 1 : 3); }
      else if (e.key.toLowerCase() === 'z' && !isTyping(e)) undo();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [result]);

  return html`<div class="col pop">
    <div class="stage" style="height:auto;min-height:220px">
      <div class="face" style="position:relative;min-height:220px">
        <span class="corner">Term</span>
        <div class="tools">
          <button class="btn ghost icon-btn" title="Speak" onClick=${() => speak(card.front, card.lang)}><${Icon} name="speaker" /></button>
          <button class="btn ghost icon-btn star ${starred ? 'on' : ''}" title="Star" onClick=${onStar}><${Icon} name="star" fill=${starred} /></button>
        </div>
        ${card.image && html`<img src=${card.image} alt="" />`}
        <${Md} src=${card.front} />
      </div>
    </div>
    ${!result
      ? html`<form class="col" onSubmit=${(e) => { e.preventDefault(); check(false); }}>
          <input class="input" ref=${ref} placeholder="Type the answer…" value=${input} onInput=${(e) => setInput(e.target.value)}
            autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" style="height:48px;font-size:17px" />
          <div class="row"><button class="btn primary grow" type="submit">Check <kbd>↵</kbd></button><button class="btn ghost" type="button" onClick=${() => check(true)}>Don't know</button></div>
        </form>`
      : html`<div class="result pop ${result === 'exact' ? 'ok' : result === 'close' ? 'close' : 'bad'}">
          <div class="small muted">${result === 'exact' ? 'Correct' : result === 'close' ? 'Almost — counted as correct (check spelling / accents)' : input ? 'Not quite' : 'Answer'}</div>
          ${input && result !== 'exact' && html`<div style="margin:6px 0"><s class="faint">${input}</s></div>`}
          <${Md} src=${card.back} />
        </div>
        <div class="row">
          <button class="btn primary grow" onClick=${() => rate(result === 'wrong' ? 1 : 3)}>Continue <kbd>↵</kbd></button>
          ${result === 'wrong' && html`<button class="btn" onClick=${() => rate(3)}>I was right</button>`}
        </div>`}
  </div>`;
}

function Summary({ q, started, back, restart }) {
  const { data: stats } = useAsync(() => api('/stats?tz=' + new Date().getTimezoneOffset()));
  const firstTry = [...q.firstTry.values()].filter(Boolean).length;
  const missed = [...q.miss].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ card: q.cards.get(id), n }));
  const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
  useEffect(() => feedback('good'), []);
  return html`<div class="study pop">
    <div style="text-align:center;padding:12px 0"><div style="font-size:40px">${missed.length ? '💪' : '🎉'}</div><h1>Session complete</h1>
      ${stats && html`<p class="muted">🔥 ${stats.streak}-day streak · ${stats.today} reviews today</p>`}</div>
    <div class="stats">
      <div class="stat"><b>${q.total}</b><span>cards</span></div>
      <div class="stat"><b>${Math.round((firstTry / q.total) * 100)}%</b><span>first-try accuracy</span></div>
      <div class="stat"><b>${mins}m</b><span>time</span></div>
    </div>
    ${missed.length > 0 && html`<div>
      <div class="section-title">Needs more practice</div>
      <div class="panel" style="padding:0">${missed.map(({ card, n }) => html`<div class="cardrow">
        <${Md} src=${card.front} /><${Md} class="back" src=${card.back} /><span class="small" style="color:var(--bad)">missed ${n}×</span></div>`)}</div>
    </div>`}
    <div class="row">
      ${missed.length > 0 && html`<button class="btn primary" onClick=${() => restart(missed.map((m) => m.card))}>Practice missed (${missed.length})</button>`}
      <button class="btn" onClick=${() => restart()}>Study again</button>
      <a class="btn ghost" href=${back}>Done</a>
    </div>
  </div>`;
}

function Match({ setId, cards, back, restart }) {
  const tiles = useMemo(() => shuffle(shuffle(cards).slice(0, 6).flatMap((c) => [
    { key: c.id + 'f', id: c.id, text: plain(c.front) },
    { key: c.id + 'b', id: c.id, text: plain(c.back) || '—' },
  ])), [cards]);
  const [sel, setSel] = useState(null);
  const [gone, setGone] = useState(new Set());
  const [wrong, setWrong] = useState([]);
  const [result, setResult] = useState(null);
  const start = useRef(performance.now()), penalty = useRef(0), clock = useRef();
  const board = useAsync(() => (setId ? api(`/sets/${setId}/match`) : Promise.resolve([])), [setId, result]);

  useEffect(() => {
    if (result) return;
    let raf;
    const loop = () => { if (clock.current) clock.current.textContent = ((performance.now() - start.current + penalty.current) / 1000).toFixed(1) + 's'; raf = requestAnimationFrame(loop); };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [result]);

  const pick = (t) => {
    if (gone.has(t.key) || result) return;
    if (!sel || sel.key === t.key) return setSel(sel?.key === t.key ? null : t);
    if (sel.id === t.id) {
      const g = new Set(gone).add(sel.key).add(t.key);
      setGone(g); setSel(null); feedback('good');
      if (g.size === tiles.length) {
        const ms = Math.round(performance.now() - start.current + penalty.current);
        setResult(ms);
        if (setId) api(`/sets/${setId}/match`, { method: 'POST', body: { ms } }).then(board.reload, (e) => toast(e.message));
      }
    } else {
      penalty.current += 1000;
      setWrong([sel.key, t.key]); setSel(null); feedback('bad');
      setTimeout(() => setWrong([]), 400);
    }
  };

  return html`<div class="study">
    <div class="row between">
      <a class="btn ghost sm" href=${back}><${Icon} name="x" /> Match</a>
      ${result == null ? html`<span class="timer" ref=${clock} />` : html`<span class="timer">${(result / 1000).toFixed(1)}s</span>`}
      <span class="small faint">+1s per miss</span>
    </div>
    ${result == null
      ? html`<div class="match">${tiles.map((t) => html`<button key=${t.key} onClick=${() => pick(t)}
          class="mtile ${sel?.key === t.key ? 'sel' : ''} ${gone.has(t.key) ? 'gone' : ''} ${wrong.includes(t.key) ? 'wrong' : ''}">${t.text.slice(0, 140)}</button>`)}</div>`
      : html`<div class="col pop">
          <div style="text-align:center"><div style="font-size:40px">⏱</div><h1>${(result / 1000).toFixed(1)}s</h1></div>
          <div class="panel"><div class="section-title">Leaderboard</div>
            <table class="list"><tbody>${(board.data || []).map((s, i) => html`<tr style=${s.ms === result ? 'font-weight:600' : ''}>
              <td class="faint">${i + 1}</td><td>${s.name}</td><td style="text-align:right" class="timer small">${(s.ms / 1000).toFixed(1)}s</td></tr>`)}</tbody></table></div>
          <div class="row"><button class="btn primary" onClick=${restart}>Play again</button><a class="btn ghost" href=${back}>Done</a></div>
        </div>`}
  </div>`;
}
