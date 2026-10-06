import { html, useState, useEffect, useCallback } from '/vendor/htm-preact.js';
import { md } from '/md.js';
import { plain } from '/lib.js';

export async function api(path, { method = 'GET', body, file } = {}) {
  const headers = { 'X-Flipp': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (file) headers['Content-Type'] = file.type;
  const res = await fetch('/api' + path, { method, headers, credentials: 'same-origin', body: file || (body !== undefined ? JSON.stringify(body) : undefined) });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !path.startsWith('/auth/')) dispatchEvent(new Event('flipp:auth'));
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true });
  const run = useCallback(() => fn().then((data) => setState({ data }), (error) => setState({ error })), deps);
  useEffect(() => { setState({ loading: true }); run(); }, [run]);
  return { ...state, reload: run };
}

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
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}

// Tactile feedback: tiny synthesized sounds (no audio files) + vibration where supported.
let audio;
export function feedback(kind) {
  if (prefs.get('haptics', true)) navigator.vibrate?.(kind === 'bad' ? [12, 40, 12] : 8);
  if (!prefs.get('sound', false)) return;
  try {
    audio ||= new AudioContext();
    const tones = { flip: [[520, 0.03]], good: [[660, 0.06], [880, 0.08]], bad: [[220, 0.12]] }[kind] || [];
    let t = audio.currentTime;
    for (const [freq, dur] of tones) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = kind === 'flip' ? 'triangle' : 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur;
    }
  } catch {}
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
};
export const Icon = ({ name, fill }) => html`<svg viewBox="0 0 24 24" width="18" height="18" fill=${fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${paths[name]} /></svg>`;
