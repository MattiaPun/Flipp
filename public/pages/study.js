// Study modes: Learn (spaced repetition), Flashcards, Write, Multiple choice, Cram, Match, Practice test,
// Survival, Listening, Speaking, and path lessons.
import { html, useState, useEffect, useLayoutEffect, useRef, useMemo, useReducer } from '/vendor/htm-preact.js';
import { api, useAsync, toast, feedback, confetti, speak, prefs, Md, Icon, Illustration } from '/ui.js';
import { StudyQueue, grade, plain, shuffle, sides, charDiff, specialChars } from '/lib.js';
import { preview } from '/srs.js';
import { queueReview, unqueueReview, flushReviews } from '/offline.js';
import { Quests } from '/pages/home.js';

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

export const MODES = {
  learn: { ico: 'repeat', title: 'Learn', sub: 'Spaced repetition', api: 'srs', records: true },
  flip: { ico: 'cards', title: 'Flashcards', sub: 'Flip & swipe', api: 'all', records: true },
  write: { ico: 'pencil', title: 'Write', sub: 'Type the answer', api: 'all', records: true },
  choice: { ico: 'list', title: 'Multiple choice', sub: 'Pick the answer', api: 'all', records: false },
  cram: { ico: 'bolt', title: 'Cram', sub: 'Weakest first, no schedule', api: 'cram', records: false },
  match: { ico: 'grid', title: 'Match', sub: 'Beat the clock', api: 'all', records: false },
  test: { ico: 'clipboard', title: 'Practice test', sub: 'Mixed questions, scored', api: 'all', records: false },
  survival: { ico: 'heart', title: 'Survival', sub: 'Three lives. How far can you get?', api: 'all', records: false },
  listen: { ico: 'speaker', title: 'Listening', sub: 'Hear it, type it', api: 'all', records: false, dir: 'front' },
  // Say the term: the definition is the prompt, so the answer is the side in the course's language.
  speak: { ico: 'mic', title: 'Speaking', sub: 'Say it out loud', api: 'all', records: false, dir: 'back', hidden: !SpeechRec },
  lesson: { ico: 'path', title: 'Lesson', sub: 'One unit of the path', api: 'all', records: true, hidden: true },
};
// Modes where the card is answered (typed, picked or spoken) instead of flipped; they play their own sound on check.
const ANSWERED = new Set(['write', 'choice', 'listen', 'speak', 'lesson']);
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

// Entry: #/study?set=1|course=1|tag=x &mode=learn &dir=front|back|both &starred=1 &len=20 &min=10 &unit=n (lesson)
export function Study({ query }) {
  const mode = MODES[query.mode] ? query.mode : 'learn';
  const scope = query.set ? `set=${query.set}` : query.course ? `course=${query.course}` : query.tag ? `tag=${encodeURIComponent(query.tag)}` : '';
  const back = query.set ? `#/set/${query.set}` : query.course ? `#/course/${query.course}` : query.tag ? `#/tags` : '#/';
  const dir = MODES[mode].dir || (['front', 'back', 'both'].includes(query.dir) ? query.dir : 'front');
  const unit = mode === 'lesson' && query.set && /^\d+$/.test(query.unit || '') ? `&unit=${query.unit}` : '';
  const { data, error, loading } = useAsync(
    () => api(`/study?${scope}&mode=${MODES[mode].api}&dir=${dir}&shuffle=1${unit}${query.starred === '1' ? '&starred=1' : ''}`),
    [scope, mode, dir, unit, query.starred]);
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
  const ctx = { w: data.w, configs: data.configs, back, mode, minutes: Number(query.min) || 0, setId: query.set, scope };
  if (mode === 'match') return html`<${Match} key=${round.n} items=${items} ctx=${ctx} restart=${() => restart()} />`;
  if (mode === 'test') return html`<${Test} key=${round.n} items=${items} ctx=${ctx} restart=${() => restart()} />`;
  if (mode === 'survival') return html`<${Survival} key=${round.n} items=${items} ctx=${ctx} restart=${() => restart()} />`;
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

const distinctAnswers = (items) => new Set(items.map((i) => plain(sides(i, i.variant).expected).toLowerCase())).size;
// What the learner has to produce. Listening asks for what was heard: the front, or the missing word of a cloze.
const expectedFor = (item, mode) => (mode === 'listen' && item.type !== 'cloze' ? item.front : sides(item, item.variant).expected);

function Session({ items, ctx, restart }) {
  const { mode } = ctx;
  const q = useMemo(() => new StudyQueue(items), [items]);
  const keys = useMemo(() => specialChars(items.map((i) => expectedFor(i, mode))), [items]);
  const canChoose = useMemo(() => distinctAnswers(items) >= 4, [items]);
  const [, tick] = useReducer((x) => x + 1, 0);
  const [flipped, setFlipped] = useState(false);
  const [started] = useState(Date.now());
  const [timeUp, setTimeUp] = useState(false);
  const [combo, setCombo] = useState(0);
  const best = useRef(0);
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
    setCombo((c) => { const n = r >= 3 ? c + 1 : 0; best.current = Math.max(best.current, n); return n; });
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

  if (q.done || (timeUp && !flipped)) return html`<${Summary} q=${q} started=${started} ctx=${ctx} restart=${restart} timeUp=${timeUp && !q.done} combo=${best.current} />`;
  const pct = (q.finished / q.total) * 100;
  const left = new Set(q.q).size;
  const isStarred = stars.get(item.id);
  const intervals = mode === 'learn' && item.scheduled ? preview(item.progress, Date.now(), { w: ctx.w, config: ctx.configs[item.course_id] }) : null;
  const k = item.key + ':' + q.history.length;
  const common = { item, starred: isStarred, onStar: () => toggleStar(item), onBury: item.scheduled ? () => scheduleAction(item, 'bury') : null, onSuspend: item.scheduled ? () => scheduleAction(item, 'suspend') : null };
  // Lessons start a card as multiple choice and switch to typing once it has been answered before.
  const kind = mode === 'lesson' ? (canChoose && !(item.progress?.state > 0) ? 'choice' : 'write') : mode;

  return html`<div class="study">
    <div class="study-head">
      <a class="btn ghost icon-btn" href=${ctx.back} title=${`Quit ${MODES[mode].title}`} aria-label=${`Quit ${MODES[mode].title}`}><${Icon} name="x" size=${22} /></a>
      <div class="progress" role="progressbar" aria-label="Session progress" aria-valuenow=${Math.round(pct)} aria-valuemin="0" aria-valuemax="100"><i style=${{ width: pct + '%' }} /></div>
      ${combo >= 3 && html`<span class="combo" key=${combo} title="Correct in a row"><${Icon} name="flame" size=${16} />${combo}</span>`}
      <button class="btn ghost icon-btn" onClick=${undo} disabled=${!q.history.length} title="Undo (Z)" aria-label="Undo"><${Icon} name="undo" /></button>
    </div>
    <span class="small muted" style="text-align:center;margin-top:-8px">${MODES[mode].title} · ${q.finished} / ${q.total} done · ${left} left${ctx.minutes ? html` · <${Countdown} until=${started + ctx.minutes * 60_000} />` : ''}</span>
    ${kind === 'choice' ? html`<${Choice} key=${k} ...${common} pool=${items} rate=${rate} undo=${undo} />`
      : ANSWERED.has(kind) ? html`<${Write} key=${k} ...${common} mode=${kind} keys=${keys} rate=${rate} undo=${undo} />`
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

// Recognition via the Web Speech API (Chrome/Safari). Calls onText with the best transcript.
function useSpeech(lang, onText, force) {
  const Rec = SpeechRec;
  const [listening, setListening] = useState(false);
  const rec = useRef(null);
  useEffect(() => () => rec.current?.abort(), []);
  if (!Rec || (!force && !prefs.get('speech', false))) return null;
  const start = () => {
    if (listening) { rec.current?.stop(); return; }
    const r = new Rec();
    r.lang = lang || navigator.language;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => onText(e.results[0][0].transcript);
    r.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Speech recognition: ${e.error}`); };
    r.onend = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  };
  return { listening, start };
}

// Typed answers. mode 'listen' plays the card and asks for what was heard; 'speak' answers with the microphone.
function Write({ item, rate, undo, mode = 'write', keys = [], onCheck, ...tools }) {
  const { prompt, answer } = sides(item, item.variant);
  const listen = mode === 'listen', speaking = mode === 'speak';
  const expected = expectedFor(item, mode);
  const [input, setInput] = useState('');
  const [hints, setHints] = useState(0);
  const [result, setResult] = useState(null);
  const ref = useRef(), audio = useRef();
  const target = plain(expected);
  const speech = useSpeech(item.variant === 1 || item.type === 'cloze' ? item.lang : '', (t) => {
    setInput(t);
    if (speaking) check(false, t); else ref.current?.focus();
  }, speaking);
  // Listening: a recorded clip of the front when there is one, else text-to-speech (a cloze is read out whole).
  const play = (slow) => {
    if (item.audio && item.type !== 'cloze' && audio.current) { audio.current.playbackRate = slow ? 0.7 : 1; audio.current.currentTime = 0; audio.current.play(); }
    else speak(item.type === 'cloze' ? answer : item.front, item.lang, slow ? 0.65 : 1);
  };
  useEffect(() => { if (listen) play(); if (!speaking) ref.current?.focus(); }, []);
  const check = (giveUp, value = input) => {
    const g = giveUp ? 'wrong' : grade(value, expected);
    setResult(g);
    feedback(g === 'wrong' ? 'bad' : 'good');
    onCheck?.(g !== 'wrong');
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
      if (!result) { if (listen && e.ctrlKey && e.key === ' ') { e.preventDefault(); play(); } return; }
      if (e.key === 'Enter') { e.preventDefault(); rate(ratingFor(result)); }
      else if (e.key.toLowerCase() === 'z' && !isTyping(e)) undo();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  return html`<div class="col pop">
    ${listen
      ? html`<div class="face static listen">
          <span class="corner">${item.type === 'cloze' ? 'Fill in what you hear' : 'Type what you hear'}</span>
          ${item.audio && item.type !== 'cloze' && html`<audio ref=${audio} src=${item.audio} preload="auto" />`}
          <div class="row" style="justify-content:center">
            <button class="btn primary listen-btn" onClick=${() => play(false)} aria-label="Play again"><${Icon} name="speaker" size=${30} /></button>
            <button class="btn listen-btn slow" onClick=${() => play(true)} title="Play slowly">Slow</button>
          </div>
          ${item.type === 'cloze' && html`<${Md} src=${prompt} />`}
          <span class="small faint listen-tip"><kbd>Ctrl</kbd> + <kbd>Space</kbd> plays it again</span>
        </div>`
      : html`<${Prompt} item=${item} ...${tools} />`}
    ${!result
      ? html`<form class="col" onSubmit=${(e) => { e.preventDefault(); check(false); }}>
          ${speaking && speech && html`<button type="button" class="btn lg mic-btn ${speech.listening ? 'on' : ''}" onClick=${speech.start}>
            <${Icon} name="mic" size=${24} /> ${speech.listening ? 'Listening… tap to stop' : 'Tap and say the answer'}</button>`}
          <div class="row" style="flex-wrap:nowrap">
            <input class="input grow answer-input" ref=${ref} placeholder=${speaking ? 'Or type it…' : 'Type the answer…'} value=${input} onInput=${(e) => setInput(e.target.value)}
              autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Your answer" />
            ${speech && !speaking && html`<button type="button" class="btn icon-btn ${speech.listening ? 'primary' : ''}" style="height:48px;width:48px" onClick=${speech.start} title="Answer by speaking" aria-label="Answer by speaking"><${Icon} name="mic" /></button>`}
          </div>
          ${keys.length > 0 && html`<div class="char-keys" aria-label="Insert a letter">${keys.map((ch) => html`<button type="button" class="btn sm" onPointerDown=${(e) => e.preventDefault()} onClick=${() => insert(ch)}>${ch}</button>`)}</div>`}
          <div class="row">
            <button class="btn primary grow" type="submit">Check <kbd>↵</kbd></button>
            <button class="btn ghost" type="button" onClick=${hint} disabled=${hints >= target.length}>Hint${hints ? ` (${hints})` : ''}</button>
            <button class="btn ghost" type="button" onClick=${() => check(true)}>Don't know</button>
          </div>
          ${speaking && html`<p class="small faint" style="text-align:center">Speech is recognized by your browser's provider (Google in Chrome, Apple in Safari).</p>`}
        </form>`
      : html`<div class="result pop ${result === 'exact' ? 'ok' : result === 'close' ? 'close' : 'bad'}">
          <div class="result-title">${result === 'exact' ? (hints ? 'Correct, with hints' : 'Correct') : result === 'close' ? 'Almost. Check the spelling' : input ? 'Incorrect' : 'The answer'}</div>
          ${input && result !== 'exact' && html`<div class="small muted">${speaking ? 'You said:' : 'You wrote:'}</div>
            <div class="diff" aria-label="Your answer compared to the correct one">${charDiff(input, target).map((d) => html`<span class=${d.op}>${d.ch}</span>`)}</div>`}
          ${result !== 'exact' && html`<div class="small muted">Correct answer:</div>`}
          ${listen && item.type !== 'cloze' ? html`<${Md} src=${item.front} /><div class="small muted">Meaning:</div><${Md} src=${item.back} />` : html`<${Md} src=${answer} />`}
          <${Extras} item=${item} />
        </div>
        <div class="row">
          <button class="btn lg grow ${result === 'wrong' ? 'again' : 'good'}" onClick=${() => rate(ratingFor(result))}>Continue <kbd>↵</kbd></button>
          ${result === 'wrong' && html`<button class="btn" onClick=${() => rate(3)}>I was right</button>`}
        </div>`}
  </div>`;
}

function Choice({ item, pool, rate, undo, onCheck, ...tools }) {
  const options = useMemo(() => choicesFor(item, pool), [item.key]);
  const [picked, setPicked] = useState(null);
  const { answer } = sides(item, item.variant);
  const pick = (i) => {
    if (picked !== null) return;
    setPicked(i);
    feedback(options[i].correct ? 'good' : 'bad');
    onCheck?.(options[i].correct);
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

// Records a finished session for XP and quests. Failing (offline) only costs the XP, never the session.
function reportSession(mode, answered, correct, combo = 0) {
  const n = Math.min(500, answered);
  return n > 0
    ? api('/activity', { method: 'POST', body: { mode, answered: n, correct: Math.min(n, Math.round(correct)), combo: Math.min(n, combo) } }).catch(() => null)
    : Promise.resolve(null);
}

export const XpGain = ({ a }) => a && html`<div class="col xp-box pop">
  <div class="xp-gain"><b>+${a.gained} XP</b><span>${a.xp} XP today${a.streak ? ` · ${a.streak}-day streak` : ''}</span></div>
  ${a.freezeEarned && html`<p class="small" style="text-align:center"><${Icon} name="snow" size=${14} /> ${a.streak}-day streak: you earned a streak freeze. It covers a day you miss.</p>`}
  <${Quests} quests=${a.quests} completed=${a.completed} />
</div>`;

function Summary({ q, started, ctx, restart, timeUp, combo }) {
  const answered = [...q.firstTry.keys()];
  const firstTry = [...q.firstTry.values()].filter(Boolean).length;
  const { data } = useAsync(async () => ({ a: await reportSession(ctx.mode, answered.length, firstTry, combo), stats: await api('/stats').catch(() => null) }));
  const stats = data?.stats;
  const missed = [...q.miss].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ item: q.cards.get(id), n }));
  const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
  const acc = answered.length ? Math.round((firstTry / answered.length) * 100) : 0;
  // Confetti only for a genuinely strong session, so it still means something.
  useEffect(() => { feedback('win'); if (!timeUp && answered.length >= 5 && acc >= 90) confetti(); }, []);
  return html`<div class="study pop">
    <div class="celebrate">
      <h1>${timeUp ? "Time's up" : 'Session complete'}</h1>
      ${stats && html`<p class="muted" style="margin-top:6px">${stats.today} reviews today${stats.goal ? ` · goal ${Math.min(stats.today, stats.goal)}/${stats.goal}` : ''}</p>`}</div>
    <${XpGain} a=${data?.a} />
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

function Match({ items, ctx, restart }) {
  const tiles = useMemo(() => {
    const seen = new Set();
    const picked = shuffle(items).filter((i) => { const k = plain(sides(i, i.variant).expected).toLowerCase(); if (seen.has(k) || seen.has(i.id)) return false; seen.add(k).add(i.id); return true; }).slice(0, 6);
    return shuffle(picked.flatMap((i) => {
      const s = sides(i, i.variant);
      // Raw Markdown (rendered with KaTeX in the tile); placeholder when a side is image-only.
      return [{ key: i.key + 'f', id: i.key, text: plain(s.prompt) ? s.prompt : '—' }, { key: i.key + 'b', id: i.key, text: plain(s.expected) ? s.expected : '—' }];
    }));
  }, [items]);
  const [sel, setSel] = useState(null);
  const [gone, setGone] = useState(new Set());
  const [wrong, setWrong] = useState([]);
  const [result, setResult] = useState(null);
  const start = useRef(performance.now()), penalty = useRef(0), clock = useRef();
  const board = useAsync(() => (ctx.setId ? api(`/sets/${ctx.setId}/match`) : Promise.resolve([])), [ctx.setId, result]);

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
        feedback('win');
        const pairs = tiles.length / 2;
        reportSession('match', pairs, Math.max(0, pairs - penalty.current / 1000)).then((a) => a && toast(`+${a.gained} XP`));
        if (ctx.setId) api(`/sets/${ctx.setId}/match`, { method: 'POST', body: { ms } }).then(board.reload, (e) => toast(e.message));
      }
    } else {
      penalty.current += 1000;
      setWrong([sel.key, t.key]); setSel(null); feedback('bad');
      setTimeout(() => setWrong([]), 400);
    }
  };
  if (tiles.length < 4) return html`<div class="study"><p class="muted">Match needs at least two cards with different answers.</p><a class="btn" href=${ctx.back}>Back</a></div>`;

  return html`<div class="study">
    <div class="row between">
      <a class="btn ghost sm" href=${ctx.back}><${Icon} name="x" /> Match</a>
      ${result == null ? html`<span class="timer" ref=${clock} />` : html`<span class="timer">${(result / 1000).toFixed(1)}s</span>`}
      <span class="small faint">+1s per miss</span>
    </div>
    ${result == null
      ? html`<div class="match">${tiles.map((t) => html`<button key=${t.key} onClick=${() => pick(t)}
          class="mtile ${sel?.key === t.key ? 'sel' : ''} ${gone.has(t.key) ? 'gone' : ''} ${wrong.includes(t.key) ? 'wrong' : ''}"><${Md} src=${t.text.slice(0, 300)} /></button>`)}</div>`
      : html`<div class="col pop">
          <div class="celebrate"><div class="big">${(result / 1000).toFixed(1)}s</div>
            <p class="muted" style="margin-top:8px">${board.data?.[0]?.ms === result ? 'New best on this set.' : 'All pairs matched.'}</p></div>
          ${ctx.setId && html`<div class="panel"><div class="section-title">Leaderboard</div>
            <table class="list"><tbody>${(board.data || []).map((s, i) => html`<tr style=${s.ms === result ? 'font-weight:600' : ''}>
              <td class="faint">${i + 1}</td><td>${s.name}</td><td style="text-align:right" class="timer small">${(s.ms / 1000).toFixed(1)}s</td></tr>`)}</tbody></table></div>`}
          <div class="row"><button class="btn primary lg" onClick=${restart}>Play again</button><a class="btn ghost" href=${ctx.back}>Done</a></div>
        </div>`}
  </div>`;
}

// Practice test: written, multiple-choice and true/false questions on one page, scored at the end.
function Test({ items, ctx, restart }) {
  const questions = useMemo(() => shuffle(items).slice(0, 20).map((item, i) => {
    const kind = items.length < 4 ? 'written' : ['written', 'choice', 'truefalse'][i % 3];
    const s = sides(item, item.variant);
    if (kind === 'choice') return { item, kind, options: choicesFor(item, items) };
    if (kind === 'truefalse') {
      const others = items.filter((o) => plain(sides(o, o.variant).expected) !== plain(s.expected));
      const truth = !others.length || Math.random() < 0.5;
      return { item, kind, shown: truth ? s.expected : (() => { const o = others[Math.floor(Math.random() * others.length)]; return sides(o, o.variant).expected; })(), truth };
    }
    return { item, kind };
  }), [items]);
  const [answers, setAnswers] = useState({});
  const [done, setDone] = useState(false);
  const set = (i, v) => setAnswers({ ...answers, [i]: v });
  const correct = (q, i) => {
    const a = answers[i];
    if (q.kind === 'written') return grade(a || '', sides(q.item, q.item.variant).expected) !== 'wrong';
    if (q.kind === 'choice') return a !== undefined && q.options[a].correct;
    return a !== undefined && a === q.truth;
  };
  const score = done ? questions.filter(correct).length : 0;
  const submit = () => {
    setDone(true); scrollTo({ top: 0, behavior: 'smooth' });
    const right = questions.filter(correct).length, pct = right / questions.length;
    feedback(pct >= 0.6 ? 'win' : 'bad');
    reportSession('test', questions.length, right).then((a) => a && toast(`+${a.gained} XP`));
    if (pct >= 0.9) confetti();
  };

  return html`<div class="study">
    <div class="row between">
      <a class="btn ghost sm" href=${ctx.back}><${Icon} name="x" /> Practice test</a>
      <span class="small muted">${questions.length} questions</span><span />
    </div>
    ${done && html`<div class="panel pop" style="text-align:center"><h1>${Math.round((score / questions.length) * 100)}%</h1>
      <p class="muted">${score} of ${questions.length} correct</p>
      <div class="row" style="justify-content:center;margin-top:10px"><button class="btn primary" onClick=${restart}>New test</button><a class="btn ghost" href=${ctx.back}>Done</a></div></div>`}
    ${questions.map((q, i) => {
      const s = sides(q.item, q.item.variant);
      const ok = done && correct(q, i);
      return html`<div class="panel col test-q ${done ? (ok ? 'ok' : 'bad') : ''}">
        <div class="row between small muted"><span>${i + 1}. ${q.kind === 'written' ? 'Write the answer' : q.kind === 'choice' ? 'Choose the answer' : 'True or false?'}</span>
          ${done && html`<span style=${{ color: ok ? 'var(--good)' : 'var(--bad)' }}>${ok ? 'Correct' : 'Incorrect'}</span>`}</div>
        ${q.item.image && html`<img src=${q.item.image} alt="" class="test-img" />`}
        <${Md} src=${s.prompt} />
        ${q.kind === 'written' && html`<input class="input" disabled=${done} value=${answers[i] || ''} onInput=${(e) => set(i, e.target.value)} placeholder="Your answer" autocomplete="off" spellcheck="false" />`}
        ${q.kind === 'choice' && html`<div class="choices">${q.options.map((o, j) => html`<button class="choice ${answers[i] === j ? 'picked' : ''} ${done && o.correct ? 'right' : ''} ${done && answers[i] === j && !o.correct ? 'wrong' : ''}"
          disabled=${done} onClick=${() => set(i, j)}><${Md} src=${o.text} /></button>`)}</div>`}
        ${q.kind === 'truefalse' && html`<div class="tf"><${Md} src=${q.shown} /></div>
          <div class="row">${[true, false].map((v) => html`<button class="btn ${answers[i] === v ? 'primary' : ''}" disabled=${done} onClick=${() => set(i, v)}>${v ? 'True' : 'False'}</button>`)}</div>`}
        ${done && !ok && html`<div class="small"><span class="muted">Answer: </span><${Md} src=${s.answer} /></div>`}
      </div>`;
    })}
    ${!done && html`<button class="btn primary lg" onClick=${submit}>Submit test (${Object.keys(answers).length}/${questions.length} answered)</button>`}
  </div>`;
}

// Survival: endless questions against a shrinking clock. A miss or a timeout costs a life; three and it's over.
// Starts with multiple choice, then mixes in typing. ponytail: best score lives in localStorage, per device.
const LIVES = 3;
const secondsFor = (score, kind) => Math.max(6, 18 - score * 0.5) + (kind === 'write' ? 6 : 0);

function Survival({ items, ctx, restart }) {
  const canChoose = useMemo(() => distinctAnswers(items) >= 4, [items]);
  const keys = useMemo(() => specialChars(items.map((i) => expectedFor(i, 'write'))), [items]);
  const deck = useRef([]);
  const draw = (last) => {
    if (!deck.current.length) deck.current = shuffle(items);
    if (items.length > 1 && deck.current.at(-1).key === last?.key) deck.current.unshift(deck.current.pop()); // never the same card twice in a row
    return deck.current.pop();
  };
  const [g, setG] = useState(() => ({ item: draw(null), n: 0, score: 0, lives: LIVES, combo: 0, best: 0, missed: [] }));
  const [checked, setChecked] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [over, setOver] = useState(null);
  const bestKey = `survival.${ctx.scope}`;
  const kind = canChoose && (g.score < 5 || g.n % 2 === 0) ? 'choice' : 'write';
  const secs = secondsFor(g.score, kind);

  const next = (correct) => {
    const lives = g.lives - (correct ? 0 : 1), combo = correct ? g.combo + 1 : 0;
    const n = { item: draw(g.item), n: g.n + 1, score: g.score + (correct ? 1 : 0), lives, combo, best: Math.max(g.best, combo), missed: correct ? g.missed : [...g.missed, g.item] };
    setChecked(false); setTimedOut(false); setG(n);
    if (lives > 0) return;
    const prev = prefs.get(bestKey, 0);
    if (n.score > prev) prefs.set(bestKey, n.score);
    setOver({ prev });
    feedback('win');
    reportSession('survival', n.n, n.score, n.best).then((a) => setOver({ prev, a }));
  };
  // The clock is a timeout, not the CSS animation: reduced motion shortens animations to nothing.
  useEffect(() => {
    if (checked || over) return;
    const t = setTimeout(() => { setTimedOut(true); setChecked(true); feedback('bad'); }, secs * 1000);
    return () => clearTimeout(t);
  }, [g.n, checked, over]);
  useLayoutEffect(() => {
    if (!timedOut) return;
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); next(false); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  if (over) {
    const missed = [...new Map(g.missed.map((i) => [i.key, i])).values()];
    return html`<div class="study pop">
      <div class="celebrate"><h1>Game over</h1><div class="big" style="margin-top:10px">${g.score}</div>
        <p class="muted" style="margin-top:8px">${g.score > over.prev ? (over.prev ? `New best. Previous best: ${over.prev}.` : 'Your first score on these cards.') : over.prev ? `Your best: ${over.prev}.` : 'No points this time. The first one is the hardest.'}</p></div>
      <${XpGain} a=${over.a} />
      ${missed.length > 0 && html`<div><div class="section-title">Missed</div>
        <div class="panel" style="padding:0">${missed.map((item) => { const x = sides(item, item.variant); return html`<div class="cardrow"><${Md} src=${x.prompt} /><${Md} class="back" src=${x.answer} /></div>`; })}</div></div>`}
      <div class="row" style="justify-content:center"><button class="btn primary lg" onClick=${restart}>Play again</button><a class="btn ghost" href=${ctx.back}>Done</a></div>
    </div>`;
  }
  // A hinted answer (rating 2) still counts; only a miss costs a life.
  const props = { key: g.n, item: g.item, rate: (r) => next(r >= 2), undo: () => {}, onCheck: () => setChecked(true) };
  return html`<div class="study">
    <div class="study-head">
      <a class="btn ghost icon-btn" href=${ctx.back} title="Quit Survival" aria-label="Quit Survival"><${Icon} name="x" size=${22} /></a>
      <div class="lives" aria-label=${`${g.lives} of ${LIVES} lives left`}>${Array.from({ length: LIVES }, (_, i) => html`<span class=${i < g.lives ? 'on' : ''}><${Icon} name="heart" size=${20} fill=${i < g.lives} /></span>`)}</div>
      <div class="fuse ${checked ? 'paused' : ''}" key=${g.n} role="timer"><i style=${{ animationDuration: `${secs}s` }} /></div>
      <span class="score" title="Score">${g.score}</span>
    </div>
    ${timedOut
      ? html`<div class="col pop"><${Prompt} item=${g.item} />
          <div class="result bad"><div class="result-title">Out of time</div><div class="small muted">Correct answer:</div><${Md} src=${sides(g.item, g.item.variant).answer} /></div>
          <button class="btn lg again" onClick=${() => next(false)}>Continue <kbd>↵</kbd></button></div>`
      : kind === 'choice' ? html`<${Choice} ...${props} pool=${items} />` : html`<${Write} ...${props} keys=${keys} />`}
  </div>`;
}
