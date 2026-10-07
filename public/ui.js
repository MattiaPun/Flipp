import { html, useState, useEffect, useRef, useCallback } from '/vendor/htm-preact.js';
import { md } from '/md.js';
import { plain } from '/lib.js';

// Thrown errors carry `status`, `code` (server-provided) and `offline` (network failure).
export async function api(path, { method = 'GET', body, file } = {}) {
  const headers = { 'X-Flipp': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (file) headers['Content-Type'] = file.type || 'application/octet-stream';
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, credentials: 'same-origin', body: file || (body !== undefined ? JSON.stringify(body) : undefined) });
  } catch {
    throw Object.assign(new Error("You're offline"), { offline: true, status: 0 });
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (res.status === 401 && !path.startsWith('/auth/')) dispatchEvent(new Event('flipp:auth'));
  if (res.status === 403 && data?.code === 'mfa_setup_required') dispatchEvent(new Event('flipp:auth'));
  if (!res.ok) throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status, code: data?.code, data });
  return data;
}

// Loads data for the current deps; results of superseded requests are ignored.
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    return fn().then((data) => n === seq.current && setState({ data }), (error) => n === seq.current && setState({ error }));
  }, deps);
  useEffect(() => { setState({ loading: true }); run(); }, [run]);
  return { ...state, reload: run };
}

// Wraps an async submit handler with busy + error state.
export function useSubmit(fn) {
  const [state, setState] = useState({ busy: false, error: '' });
  const submit = async (e) => {
    e?.preventDefault?.();
    setState({ busy: true, error: '' });
    try { await fn(e); setState({ busy: false, error: '' }); } catch (err) { setState({ busy: false, error: err.message }); }
  };
  return [submit, state];
}

export const formData = (e) => Object.fromEntries(new FormData(e.target));

export const prefs = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('flipp.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('flipp.' + k, JSON.stringify(v)); } catch {} },
};

export function setTheme(t) {
  if (t === 'system') { delete document.documentElement.dataset.theme; try { localStorage.removeItem('flipp.theme'); } catch {} }
  else { document.documentElement.dataset.theme = t; try { localStorage.setItem('flipp.theme', t); } catch {} }
}
export const currentTheme = () => document.documentElement.dataset.theme || 'system';

export function toast(msg) {
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg, role: 'status' });
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

// Tactile feedback: tiny synthesized sounds (no audio files) + vibration where supported.
// Sounds only ever play in response to a tap or key press, so autoplay rules are never an issue.
let audio;
const TONES = {
  flip: [[520, 0.035, 'triangle']],
  good: [[784, 0.07], [1175, 0.12]], // G5 → D6: a bright "ding-ding"
  bad: [[262, 0.09, 'square', 0.05], [196, 0.16, 'square', 0.05]],
  win: [[523, 0.09], [659, 0.09], [784, 0.09], [1047, 0.22]], // C major arpeggio
  pop: [[880, 0.04, 'triangle']],
};
export function feedback(kind) {
  if (prefs.get('haptics', true)) navigator.vibrate?.(kind === 'bad' ? [12, 40, 12] : kind === 'win' ? [10, 30, 10, 30, 20] : 8);
  if (!prefs.get('sound', true)) return;
  try {
    audio ||= new AudioContext();
    let t = audio.currentTime;
    for (const [freq, dur, type = 'sine', vol = 0.13] of TONES[kind] || []) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur * 0.8;
    }
  } catch {}
}

// A burst of CSS confetti; cleans itself up.
export function confetti(n = 90) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = Object.assign(document.createElement('div'), { className: 'confetti' });
  const colors = ['var(--brand)', 'var(--good)', 'var(--pink)', 'var(--star)', 'var(--blue)', 'var(--warn)'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};--x:${(Math.random() - 0.5) * 240}px;--r:${(Math.random() - 0.5) * 1440}deg;--d:${Math.random() * 0.5}s;--t:${1.6 + Math.random() * 1.4}s;${Math.random() < 0.3 ? 'border-radius:50%;height:9px' : ''}`;
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 3600);
}

// Flipp the card mascot. Moods: happy, cheer, sleepy, sad.
export function Mascot({ mood = 'happy', size = 72, class: cls = '' }) {
  const eyes = mood === 'sleepy'
    ? html`<path d="M30 46q6 5 12 0M58 46q6 5 12 0" stroke="#1d1b3a" stroke-width="4" fill="none" stroke-linecap="round" />`
    : html`<ellipse cx="36" cy="45" rx="7" ry="9" fill="#fff" /><ellipse cx="64" cy="45" rx="7" ry="9" fill="#fff" />
        <circle cx=${mood === 'sad' ? 36 : 38} cy=${mood === 'sad' ? 49 : 46} r="4" fill="#1d1b3a" /><circle cx=${mood === 'sad' ? 64 : 66} cy=${mood === 'sad' ? 49 : 46} r="4" fill="#1d1b3a" />
        <circle cx="39.5" cy="43" r="1.4" fill="#fff" /><circle cx="67.5" cy="43" r="1.4" fill="#fff" />`;
  const mouth = {
    happy: html`<path d="M40 62q10 9 20 0" stroke="#1d1b3a" stroke-width="4" fill="none" stroke-linecap="round" />`,
    cheer: html`<path d="M38 59q12 2 24 0q-2 14-12 14t-12-14z" fill="#1d1b3a" /><path d="M44 68q6 4 12 0" fill="#ff7aa8" />`,
    sleepy: html`<ellipse cx="50" cy="64" rx="5" ry="4" fill="#1d1b3a" />`,
    sad: html`<path d="M41 67q9-8 18 0" stroke="#1d1b3a" stroke-width="4" fill="none" stroke-linecap="round" />`,
  }[mood];
  return html`<span class="mascot ${cls}" aria-hidden="true"><svg viewBox="0 0 100 100" width=${size} height=${size}>
    <rect x="22" y="20" width="62" height="72" rx="14" fill="var(--pink)" transform="rotate(12 53 56)" />
    <rect x="16" y="14" width="66" height="76" rx="15" fill="var(--brand)" transform="rotate(-6 49 52)" />
    <rect x="22" y="20" width="22" height="7" rx="3.5" fill="#fff" opacity=".28" transform="rotate(-6 49 52)" />
    <circle cx="27" cy="58" r="5" fill="#ff7aa8" opacity=".55" /><circle cx="73" cy="58" r="5" fill="#ff7aa8" opacity=".55" />
    ${eyes}${mouth}
    ${mood === 'cheer' && html`<path d="M10 30l6 4M8 44h7M90 30l-6 4M92 44h-7" stroke="var(--star)" stroke-width="4" stroke-linecap="round" />`}
    ${mood === 'sleepy' && html`<text x="78" y="22" font-size="18" font-weight="900" fill="var(--muted)" font-family="var(--font)">z</text>`}
  </svg></span>`;
}

export function speak(text, lang) {
  if (!('speechSynthesis' in window)) return toast('Text-to-speech is not supported on this device');
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(plain(text));
  if (lang) {
    u.lang = lang;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
    if (voice) u.voice = voice;
  }
  speechSynthesis.speak(u);
}

export const Md = ({ src, class: cls = '' }) => html`<div class="md ${cls}" dangerouslySetInnerHTML=${{ __html: md(src) }} />`;

export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
export const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Native <dialog> modal. Closes on Escape / backdrop click.
export function Modal({ title, onClose, children, wide }) {
  const ref = useRef();
  useEffect(() => {
    const d = ref.current;
    d.showModal();
    const close = () => onClose();
    d.addEventListener('close', close);
    return () => { d.removeEventListener('close', close); if (d.open) d.close(); };
  }, []);
  return html`<dialog ref=${ref} class="modal ${wide ? 'wide' : ''}" onClick=${(e) => e.target === ref.current && ref.current.close()}>
    <div class="modal-body">
      <div class="row between" style="margin-bottom:14px"><h2>${title}</h2><button class="btn ghost icon-btn" onClick=${() => ref.current.close()} aria-label="Close"><${Icon} name="x" /></button></div>
      ${children}
    </div>
  </dialog>`;
}

export const Err = ({ e }) => (e ? html`<p class="error">${e.message || e}</p>` : null);

const paths = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z',
  speaker: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  x: 'M18 6 6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5V21h16',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  play: 'M6 4l14 8-14 8z',
  grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
};
export const Icon = ({ name, fill, size = 18 }) => html`<svg viewBox="0 0 24 24" width=${size} height=${size} fill=${fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${paths[name]} /></svg>`;
