// Small shared helpers: errors, input validation, time.
import crypto from 'node:crypto';

export const now = () => Date.now();
export const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const httpError = (status, message, extra) => Object.assign(new Error(message), { status, expose: true, extra });

// String field: trimmed, length-checked. `def` is returned when the field is absent.
export const str = (v, max, { min = 0, def } = {}) => {
  if (v === undefined && def !== undefined) return def;
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw httpError(400, `Invalid field (expected ${min}–${max} characters)`);
  return v.trim();
};

export const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw httpError(404, 'Not found');
  return n;
};

export const int = (v, lo, hi, def) => {
  if (v === undefined || v === null || v === '') { if (def !== undefined) return def; throw httpError(400, 'Missing number'); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw httpError(400, `Expected a whole number between ${lo} and ${hi}`);
  return n;
};

export const email = (v) => {
  const e = str(v, 254, { min: 3 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw httpError(400, 'Invalid email');
  return e;
};

export const password = (v) => str(v, 256, { min: 8 });

const UPLOAD = /^\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const AUDIO = /^\/uploads\/[a-f0-9]{32}\.(webm|ogg|m4a|mp4|mp3|wav)$/;
export const image = (v) => { if (!v) return null; if (!UPLOAD.test(v)) throw httpError(400, 'Invalid image'); return v; };
export const audio = (v) => { if (!v) return null; if (!AUDIO.test(v)) throw httpError(400, 'Invalid audio'); return v; };

export const tagList = (v, max = 20) =>
  [...new Set(String(v ?? '').split(',').map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))].slice(0, max).map((t) => t.slice(0, 40));

export const json = (s, def) => { try { return JSON.parse(s) ?? def; } catch { return def; } };

const fmts = new Map();
const formatter = (timeZone) => {
  if (!fmts.has(timeZone)) {
    const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' };
    let f;
    try { f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone }); } catch { f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }); }
    fmts.set(timeZone, f);
  }
  return fmts.get(timeZone);
};
export const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

// Calendar date, minutes-since-midnight and weekday of `ts` in an IANA timezone (UTC on bad input).
export function zonedParts(ts, timeZone = 'UTC') {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}

export const INSTANCE_TZ = process.env.TZ || 'UTC';

// Local calendar day helpers for a user's timezone.
export const dayKey = (ts, tz) => zonedParts(ts, tz).date;
export const startOfDay = (ts, tz) => ts - zonedParts(ts, tz).minutes * 60_000 - (ts % 60_000);
