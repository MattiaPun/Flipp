import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { db, getSetting, setSetting } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 30 * 86_400_000;
const COOKIE = 'flipp_session';
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// JWT_SECRET signs short-lived OIDC state cookies and keys session-token hashes.
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = (await getSetting('generated_secret')) || crypto.randomBytes(32).toString('hex');
  await setSetting('generated_secret', SECRET);
  console.warn('[flipp] JWT_SECRET not set; using a generated secret stored in the database.');
}

const oidc = process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID
  ? {
      issuer: process.env.OIDC_ISSUER.replace(/\/$/, ''),
      clientId: process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET || '',
      scopes: process.env.OIDC_SCOPES || 'openid email profile',
      name: process.env.OIDC_NAME || 'SSO',
      authMethod: process.env.OIDC_TOKEN_AUTH_METHOD || 'client_secret_basic',
      allowSignup: process.env.OIDC_ALLOW_SIGNUP !== 'false',
      adminGroup: process.env.OIDC_ADMIN_GROUP || '',
    }
  : null;

const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const tokenHash = (t) => crypto.createHmac('sha256', SECRET).update(t).digest('hex');
const now = () => Date.now();

export const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 64)).toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [, salt, hash] = (stored || 'scrypt$AAAA$AAAA').split('$');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), 64);
  const want = Buffer.from(hash, 'base64');
  return !!stored && want.length === got.length && crypto.timingSafeEqual(got, want);
}

function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
function unsign(value) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString());
}

export const parseCookies = (header = '') =>
  Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

const isSecure = (req) => (PUBLIC_URL ? PUBLIC_URL.startsWith('https:') : req.secure);
const cookieOpts = (req, extra) => ({ httpOnly: true, sameSite: 'lax', secure: isSecure(req), path: '/', ...extra });

async function startSession(req, res, userId) {
  const token = rand();
  await db.run('DELETE FROM sessions WHERE expires_at < ?', now());
  await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', tokenHash(token), userId, now() + SESSION_MS);
  res.cookie(COOKIE, token, cookieOpts(req, { maxAge: SESSION_MS }));
}

// Loads req.user from the session cookie (if any).
export async function sessionMiddleware(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    req.user = await db.get(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
      tokenHash(token), now());
  }
  next();
}

export const requireUser = (req, _res, next) => next(req.user ? undefined : httpError(401, 'Not signed in'));
export const requireAdmin = (req, _res, next) => next(req.user?.role === 'admin' ? undefined : httpError(403, 'Admins only'));

// Simple in-memory sliding-window limiter, keyed by client IP + route.
// ponytail: per-process memory; use a shared store if you ever run more than one replica.
const hits = new Map();
export const rateLimit = (max, windowMs) => (req, res, next) => {
  const key = `${req.ip}|${req.path}`;
  const t = now();
  const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
  list.push(t);
  hits.set(key, list);
  if (list.length > max) return res.status(429).set('Retry-After', String(Math.ceil(windowMs / 1000))).json({ error: 'Too many attempts. Try again in a minute.' });
  next();
};
setInterval(() => { for (const [k, v] of hits) if (now() - v[v.length - 1] > 3_600_000) hits.delete(k); }, 600_000).unref();

const needsSetup = async () => !(await getSetting('setup_done'));
export const registrationOpen = async () => ((await getSetting('allow_registration')) ?? String(process.env.ALLOW_REGISTRATION !== 'false')) === 'true';

const str = (v, max, min = 0) => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw httpError(400, `Invalid field (expected ${min}–${max} characters)`);
  return v.trim();
};
const email = (v) => {
  const e = str(v, 254, 3).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw httpError(400, 'Invalid email');
  return e;
};
const password = (v) => str(v, 256, 8);

async function createUser({ email: e, name, pw, role = 'user', sub = null }) {
  const exists = await db.get('SELECT id FROM users WHERE email = ?', e);
  if (exists) throw httpError(409, 'An account with this email already exists');
  return db.get('INSERT INTO users (email, name, password_hash, role, oidc_sub, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    e, name || e.split('@')[0], pw ? await hashPassword(pw) : null, role, sub, now());
}

export const authRouter = Router();
const limited = rateLimit(10, 60_000);

authRouter.get('/me', async (req, res) => {
  res.json({
    user: req.user || null,
    needsSetup: await needsSetup(),
    allowRegistration: await registrationOpen(),
    oidc: oidc ? { name: oidc.name } : null,
  });
});

authRouter.post('/setup', limited, async (req, res) => {
  if (!(await needsSetup())) throw httpError(409, 'Setup already completed');
  const e = email(req.body.email), pw = password(req.body.password);
  // The settings primary key makes this atomic: a concurrent second setup request fails here.
  await db.run("INSERT INTO settings (key, value) VALUES ('setup_done', '1')");
  const user = await createUser({ email: e, name: str(req.body.name || '', 80), pw, role: 'admin' });
  await startSession(req, res, user.id);
  res.json({ ok: true });
});

authRouter.post('/register', limited, async (req, res) => {
  if (await needsSetup()) throw httpError(403, 'Instance setup is not finished');
  const e = email(req.body.email), pw = password(req.body.password);
  const code = typeof req.body.invite === 'string' ? req.body.invite : '';
  const invite = code && (await db.get('SELECT * FROM invites WHERE code = ? AND used_by IS NULL AND expires_at > ?', code, now()));
  if (code && !invite) throw httpError(400, 'Invite is invalid or expired');
  if (!invite && !(await registrationOpen())) throw httpError(403, 'Registration is disabled on this instance');
  const user = await createUser({ email: e, name: str(req.body.name || '', 80), pw });
  if (invite) {
    const claimed = await db.run('UPDATE invites SET used_by = ? WHERE code = ? AND used_by IS NULL', user.id, code);
    if (!claimed.changes) { await db.run('DELETE FROM users WHERE id = ?', user.id); throw httpError(400, 'Invite already used'); }
  }
  await startSession(req, res, user.id);
  res.json({ ok: true });
});

authRouter.post('/login', limited, async (req, res) => {
  const e = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT id, password_hash FROM users WHERE email = ?', e);
  const ok = await verifyPassword(String(req.body.password || ''), user?.password_hash); // runs scrypt even for unknown users
  if (!user || !ok) throw httpError(401, 'Wrong email or password');
  await startSession(req, res, user.id);
  res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash(token));
  res.clearCookie(COOKIE, cookieOpts(req)).json({ ok: true });
});

authRouter.post('/password', limited, requireUser, async (req, res) => {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (row.password_hash && !(await verifyPassword(String(req.body.current || ''), row.password_hash))) throw httpError(401, 'Current password is wrong');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password(req.body.password)), req.user.id);
  res.json({ ok: true });
});

// ---------- OpenID Connect (authorization code + PKCE) ----------
let discovery;
async function oidcConfig() {
  if (!discovery) {
    const r = await fetch(`${oidc.issuer}/.well-known/openid-configuration`);
    if (!r.ok) throw httpError(502, 'OIDC discovery failed');
    discovery = await r.json();
  }
  return discovery;
}
const redirectUri = (req) => `${PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/api/auth/oidc/callback`;

authRouter.get('/oidc/login', limited, async (req, res) => {
  if (!oidc) throw httpError(404, 'OIDC is not configured');
  const cfg = await oidcConfig();
  const state = rand(), nonce = rand(), verifier = rand();
  res.cookie('flipp_oidc', sign({ state, nonce, verifier, exp: now() + 600_000 }), cookieOpts(req, { maxAge: 600_000, path: '/api/auth/oidc' }));
  const url = new URL(cfg.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: oidc.clientId, redirect_uri: redirectUri(req), scope: oidc.scopes, state, nonce,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  })) url.searchParams.set(k, v);
  res.redirect(url.href);
});

authRouter.get('/oidc/callback', limited, async (req, res) => {
  const fail = (why) => { console.warn('[flipp] OIDC login failed:', why); res.redirect(`/#/login?error=${encodeURIComponent(why)}`); };
  if (!oidc) return fail('OIDC is not configured');
  const st = unsign(parseCookies(req.headers.cookie).flipp_oidc);
  res.clearCookie('flipp_oidc', cookieOpts(req, { path: '/api/auth/oidc' }));
  if (!st || st.exp < now() || st.state !== req.query.state || typeof req.query.code !== 'string') return fail('Invalid or expired login state');

  const cfg = await oidcConfig();
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri(req), code_verifier: st.verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (oidc.authMethod === 'client_secret_post') { form.set('client_id', oidc.clientId); form.set('client_secret', oidc.clientSecret); }
  else headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`).toString('base64');
  const tr = await fetch(cfg.token_endpoint, { method: 'POST', headers, body: form });
  const tokens = await tr.json().catch(() => ({}));
  if (!tr.ok || !tokens.id_token) return fail(`Token exchange failed (${tr.status})`);

  // The ID token comes straight from the token endpoint over TLS, so per OIDC Core §3.1.3.7 we
  // validate its claims rather than its signature.
  let claims;
  try { claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()); } catch { return fail('Malformed ID token'); }
  const aud = [].concat(claims.aud);
  if (claims.iss !== cfg.issuer || !aud.includes(oidc.clientId) || claims.nonce !== st.nonce || claims.exp * 1000 < now() || !claims.sub) return fail('ID token validation failed');
  if (!claims.email && cfg.userinfo_endpoint && tokens.access_token) {
    const ui = await fetch(cfg.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (ui.ok) { const info = await ui.json(); if (info.sub === claims.sub) claims = { ...info, ...claims, email: info.email, email_verified: info.email_verified }; }
  }

  const sub = `${claims.iss}|${claims.sub}`;
  const mail = String(claims.email || `${claims.sub}@oidc.invalid`).toLowerCase();
  const isAdminByGroup = oidc.adminGroup && [].concat(claims.groups || []).includes(oidc.adminGroup);
  let user = await db.get('SELECT id FROM users WHERE oidc_sub = ?', sub);
  if (!user && claims.email && claims.email_verified === true) {
    user = await db.get('SELECT id FROM users WHERE email = ? AND oidc_sub IS NULL', mail); // link verified email to existing local account
    if (user) await db.run('UPDATE users SET oidc_sub = ? WHERE id = ?', sub, user.id);
  }
  if (!user) {
    const first = await needsSetup();
    if (!first && !oidc.allowSignup) return fail('No account for this identity. Ask an admin for access.');
    if (first) await db.run("INSERT INTO settings (key, value) VALUES ('setup_done', '1')");
    try {
      user = await createUser({ email: mail, name: claims.name || claims.preferred_username, sub, role: first ? 'admin' : 'user' });
    } catch (e) { return fail(e.message); }
  }
  if (isAdminByGroup) await db.run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
  await startSession(req, res, user.id);
  res.redirect('/#/');
});
