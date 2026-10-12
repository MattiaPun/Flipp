// Session, password and token primitives + request middleware. Routes live in routes/auth.js and routes/account.js.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, getSetting, setSetting } from './db.js';
import { httpError, now, rand } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 86_400_000;
export const COOKIE = 'flipp_session';
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
export const baseUrl = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// JWT_SECRET keys session-token hashes, signed cookies/tickets and the encryption of stored TOTP secrets.
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = (await getSetting('generated_secret')) || crypto.randomBytes(32).toString('hex');
  await setSetting('generated_secret', SECRET);
  console.warn('[flipp] JWT_SECRET not set; using a generated secret stored in the database.');
}

const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
export const tokenHash = hmac;

// ---------- Passwords ----------
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 64)).toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [, salt, hash] = (stored || 'scrypt$AAAA$AAAA').split('$');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), 64); // runs even when `stored` is empty (timing)
  const want = Buffer.from(hash, 'base64');
  return !!stored && want.length === got.length && crypto.timingSafeEqual(got, want);
}

// ---------- Signed values (cookies, short-lived tickets) ----------
export function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
export function unsign(value, purpose) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (purpose && obj.purpose !== purpose) return null;
    if (obj.exp && obj.exp < now()) return null;
    return obj;
  } catch { return null; }
}

// ---------- Encryption at rest (TOTP secrets) ----------
const encKey = crypto.createHash('sha256').update(`${SECRET}:flipp-enc`).digest();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}
export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob || '').split(':');
  if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---------- Cookies & sessions ----------
export const parseCookies = (header = '') =>
  Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => {
    try { return [k, decodeURIComponent(v.join('='))]; } catch { return [k, '']; }
  }));

const isSecure = (req) => (PUBLIC_URL ? PUBLIC_URL.startsWith('https:') : req.secure);
export const cookieOpts = (req, extra) => ({ httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/', ...extra });

export async function startSession(req, res, userId, method = 'password') {
  const token = rand();
  const t = now();
  await db.run('DELETE FROM sessions WHERE expires_at < ?', t);
  await db.run('INSERT INTO sessions (token_hash, id, user_id, expires_at, created_at, last_seen, ip, user_agent, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    tokenHash(token), rand(12), userId, t + SESSION_MS, t, t, req.ip || '', String(req.get('user-agent') || '').slice(0, 300), method);
  res.cookie(COOKIE, token, cookieOpts(req, { maxAge: SESSION_MS }));
}

export async function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
  res.clearCookie(COOKIE, cookieOpts(req));
}

const STRONG_METHODS = ['totp', 'passkey', 'oidc'];

// Loads req.user and req.session from the session cookie (if any).
export async function sessionMiddleware(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = await db.get(
      `SELECT u.id, u.email, u.name, u.role, u.totp_secret IS NOT NULL AS has_totp, u.oidc_sub IS NOT NULL AS sso,
              s.id AS session_id, s.method, s.created_at AS session_created, s.last_seen, s.token_hash
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
      tokenHash(token), now());
    if (row) {
      const { session_id, method, session_created, last_seen, token_hash, has_totp, sso, ...user } = row;
      req.user = { ...user, hasTotp: !!has_totp, sso: !!sso };
      req.session = { id: session_id, method, createdAt: Number(session_created) };
      if (now() - last_seen > 5 * 60_000) await db.run('UPDATE sessions SET last_seen = ?, ip = ? WHERE token_hash = ?', now(), req.ip || '', token_hash);
      // Admins may be required to use 2FA. Sessions not proven by a second factor (or SSO) can then only reach the security settings.
      if (user.role === 'admin' && !has_totp && !STRONG_METHODS.includes(method) && (await getSetting('require_2fa_admins')) === 'true') req.user.mfaSetupRequired = true;
    }
  }
  next();
}

const MFA_ALLOWED = /^\/(auth\/|account\/(security|totp|passkeys|me)\b)/;
export const requireUser = (req, _res, next) => {
  if (!req.user) return next(httpError(401, 'Not signed in'));
  if (req.user.mfaSetupRequired && !MFA_ALLOWED.test(req.path)) return next(httpError(403, 'Set up two-factor authentication to continue', { code: 'mfa_setup_required' }));
  next();
};
export const requireAdmin = (req, _res, next) => next(req.user?.role === 'admin' ? undefined : httpError(403, 'Admins only'));

// ---------- Rate limiting ----------
// Simple in-memory sliding-window limiter, keyed by client IP + route.
// ponytail: per-process memory; use a shared store if you ever run more than one replica.
const hits = new Map();
export const rateLimit = (max, windowMs, keyFn) => (req, res, next) => {
  const key = `${keyFn ? keyFn(req) : req.ip}|${req.baseUrl}${req.path}`;
  const t = now();
  const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
  list.push(t);
  hits.set(key, list);
  if (list.length > max) return res.status(429).set('Retry-After', String(Math.ceil(windowMs / 1000))).json({ error: 'Too many attempts. Try again later.' });
  next();
};
setInterval(() => { for (const [k, v] of hits) if (now() - v[v.length - 1] > 3_600_000) hits.delete(k); }, 600_000).unref();

// ---------- Instance setup ----------
export const needsSetup = async () => !(await getSetting('setup_done'));
export const registrationOpen = async () => ((await getSetting('allow_registration')) ?? String(process.env.ALLOW_REGISTRATION !== 'false')) === 'true';

// Until the first admin exists, setup requires a token: SETUP_TOKEN from the environment, or a generated one printed to the logs.
let setupToken = null;
export async function initSetupToken() {
  if (!(await needsSetup())) return;
  setupToken = process.env.SETUP_TOKEN || rand(18);
  const where = `${PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`}/#/setup?token=${process.env.SETUP_TOKEN ? '<SETUP_TOKEN>' : setupToken}`;
  console.log(`[flipp] First run: create the admin account at ${where}`);
  if (!process.env.SETUP_TOKEN) console.log(`[flipp] Setup token: ${setupToken}`);
}
export function checkSetupToken(t) {
  if (!setupToken || typeof t !== 'string') return false;
  const a = Buffer.from(hmac(t)), b = Buffer.from(hmac(setupToken));
  return crypto.timingSafeEqual(a, b);
}
// Atomic: the settings primary key makes a concurrent second completion fail.
export async function completeSetup() {
  await db.run("INSERT INTO settings (key, value) VALUES ('setup_done', '1')");
  setupToken = null;
}

// ---------- Users ----------
export async function createUser({ email, name, pw, role = 'user', sub = null, verified = false }) {
  if (await db.get('SELECT id FROM users WHERE email = ?', email)) throw httpError(409, 'An account with this email already exists');
  return db.get('INSERT INTO users (email, name, password_hash, role, oidc_sub, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    email, name || email.split('@')[0], pw ? await hashPassword(pw) : null, role, sub, verified ? 1 : 0, now());
}
