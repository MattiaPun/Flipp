// Unauthenticated auth flows: setup, register, login (+2FA step), passkey login, password reset, email verification, OIDC.
import crypto from 'node:crypto';
import { Router } from 'express';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { db, getSetting } from '../db.js';
import { httpError, now, rand, str, email as emailField, password as passwordField } from '../util.js';
import {
  baseUrl, checkSetupToken, completeSetup, cookieOpts, createUser, decrypt, endSession, hashPassword, needsSetup, parseCookies,
  PUBLIC_URL, rateLimit, registrationOpen, sign, startSession, tokenHash, unsign, verifyPassword,
} from '../auth.js';
import { audit } from '../audit.js';
import { mailEnabled, sendMail } from '../mailer.js';
import { verifyTotp } from '../totp.js';
import { branding } from '../branding.js';

export const authRouter = Router();
const limited = rateLimit(10, 60_000);
const t = now;

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

export const rp = (req) => { const origin = baseUrl(req); return { origin, rpID: new URL(origin).hostname }; };
const requireVerification = async () => mailEnabled() && (await getSetting('require_email_verification')) === 'true';

async function issueToken(userId, kind, ttlMs) {
  const token = rand();
  await db.run('DELETE FROM tokens WHERE expires_at < ?', t());
  await db.run('DELETE FROM tokens WHERE user_id = ? AND kind = ?', userId, kind);
  await db.run('INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)', tokenHash(token), userId, kind, t() + ttlMs);
  return token;
}
async function consumeToken(token, kind) {
  if (typeof token !== 'string' || !token) return null;
  const row = await db.get('SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND expires_at > ?', tokenHash(token), kind, t());
  if (!row) return null;
  const del = await db.run('DELETE FROM tokens WHERE token_hash = ?', row.token_hash);
  return del.changes ? row : null; // a concurrent request already used it
}

async function sendVerification(req, user) {
  const token = await issueToken(user.id, 'verify', 24 * 3_600_000);
  const name = (await branding()).name;
  await sendMail({ to: user.email, subject: `Confirm your email for ${name}`,
    text: `Hi ${user.name || ''},\n\nConfirm your email address to start using ${name}:\n\n${baseUrl(req)}/#/verify?token=${token}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.` });
}

authRouter.get('/me', async (req, res) => {
  res.json({
    user: req.user ? { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role, hasTotp: req.user.hasTotp, sso: req.user.sso, mfaSetupRequired: !!req.user.mfaSetupRequired } : null,
    needsSetup: await needsSetup(),
    allowRegistration: await registrationOpen(),
    oidc: oidc ? { name: oidc.name } : null,
    mail: mailEnabled(),
    branding: await branding(),
  });
});

authRouter.post('/setup', limited, async (req, res) => {
  if (!(await needsSetup())) throw httpError(409, 'Setup already completed');
  if (!checkSetupToken(req.body.token)) throw httpError(403, 'Invalid setup token. Find it in the server logs, or set SETUP_TOKEN.');
  const e = emailField(req.body.email), pw = passwordField(req.body.password);
  await completeSetup();
  const user = await createUser({ email: e, name: str(req.body.name || '', 80), pw, role: 'admin', verified: true });
  await audit(req, 'auth.setup', { user: { id: user.id, email: e } });
  await startSession(req, res, user.id);
  res.json({ ok: true });
});

authRouter.post('/register', limited, async (req, res) => {
  if (await needsSetup()) throw httpError(403, 'Instance setup is not finished');
  const e = emailField(req.body.email), pw = passwordField(req.body.password);
  const code = typeof req.body.invite === 'string' ? req.body.invite : '';
  const invite = code && (await db.get('SELECT * FROM invites WHERE code = ? AND used_by IS NULL AND expires_at > ?', code, t()));
  if (code && !invite) throw httpError(400, 'Invite is invalid or expired');
  if (!invite && !(await registrationOpen())) throw httpError(403, 'Registration is disabled on this instance');
  const verify = !invite && (await requireVerification()); // an emailed invite already proves the address... and admins vouch for invite links
  const user = await createUser({ email: e, name: str(req.body.name || '', 80), pw, verified: !verify });
  if (invite) {
    const claimed = await db.run('UPDATE invites SET used_by = ? WHERE code = ? AND used_by IS NULL', user.id, code);
    if (!claimed.changes) { await db.run('DELETE FROM users WHERE id = ?', user.id); throw httpError(400, 'Invite already used'); }
  }
  await audit(req, 'auth.register', { user: { id: user.id, email: e }, details: { invite: !!invite } });
  if (verify) {
    await sendVerification(req, { id: user.id, email: e, name: req.body.name });
    return res.json({ verify: true });
  }
  await startSession(req, res, user.id);
  res.json({ ok: true });
});

authRouter.post('/login', limited, async (req, res) => {
  const e = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT id, email, name, password_hash, totp_secret, email_verified FROM users WHERE email = ?', e);
  const ok = await verifyPassword(String(req.body.password || ''), user?.password_hash); // runs scrypt even for unknown users
  if (!user || !ok) {
    await audit(req, 'auth.login_failed', { target: e.slice(0, 120), user: user ? { id: user.id, email: user.email } : { email: '' } });
    throw httpError(401, 'Wrong email or password');
  }
  if (!user.email_verified && (await requireVerification())) {
    throw httpError(403, 'Confirm your email address first. Check your inbox, or request a new link.', { code: 'email_unverified' });
  }
  if (user.totp_secret) {
    return res.json({ mfa: true, ticket: sign({ purpose: 'mfa', uid: user.id, exp: t() + 5 * 60_000 }) });
  }
  await audit(req, 'auth.login', { user });
  await startSession(req, res, user.id, 'password');
  res.json({ ok: true });
});

// Wrong second factors per account: the per-IP limiter alone would let a distributed attacker keep guessing.
// ponytail: per-process memory, like rateLimit; move to the DB if you run several replicas.
const MFA_MAX_FAILS = 5, MFA_WINDOW = 5 * 60_000, MFA_LOCK = 10 * 60_000; // window = ticket lifetime
const mfaFails = new Map(); // uid -> { n, since, lockedUntil }
function mfaFailed(uid) {
  const f = mfaFails.get(uid);
  const cur = f && t() - f.since < MFA_WINDOW ? f : { n: 0, since: t(), lockedUntil: 0 };
  if (++cur.n >= MFA_MAX_FAILS) cur.lockedUntil = t() + MFA_LOCK;
  mfaFails.set(uid, cur);
}

// Second step: TOTP code or a one-time recovery code.
authRouter.post('/login/mfa', limited, async (req, res) => {
  const ticket = unsign(req.body.ticket, 'mfa');
  if (!ticket) throw httpError(401, 'Your sign-in expired. Start again.');
  if (mfaFails.get(ticket.uid)?.lockedUntil > t()) throw httpError(429, 'Too many wrong codes. Try again in 10 minutes.');
  const user = await db.get('SELECT id, email, totp_secret, totp_last_step FROM users WHERE id = ?', ticket.uid);
  if (!user?.totp_secret) throw httpError(401, 'Your sign-in expired. Start again.');
  const code = String(req.body.code || '').trim();
  const step = verifyTotp(decrypt(user.totp_secret), code, { lastStep: user.totp_last_step ?? -1 });
  let method = 'totp';
  if (step !== null) {
    const upd = await db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', step, user.id, step);
    if (!upd.changes) { mfaFailed(user.id); throw httpError(401, 'That code was already used. Wait for the next one.'); }
  } else {
    const hash = tokenHash(code.toLowerCase().replace(/[\s-]/g, ''));
    const used = await db.run('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', t(), user.id, hash);
    if (!used.changes) {
      mfaFailed(user.id);
      await audit(req, 'auth.mfa_failed', { user });
      throw httpError(401, 'Invalid code');
    }
    method = 'recovery';
    await audit(req, 'auth.recovery_code_used', { user });
  }
  mfaFails.delete(user.id);
  await audit(req, 'auth.login', { user, details: { method } });
  await startSession(req, res, user.id, 'totp');
  res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  if (req.user) await audit(req, 'auth.logout');
  await endSession(req, res);
  res.json({ ok: true });
});

// ---------- Password reset ----------
authRouter.post('/forgot', rateLimit(5, 60_000), async (req, res) => {
  if (!mailEnabled()) throw httpError(503, 'Password reset by email is not available on this instance. Ask an admin.');
  const e = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT id, email, name FROM users WHERE email = ?', e);
  if (user) {
    const token = await issueToken(user.id, 'reset', 3_600_000);
    const name = (await branding()).name;
    sendMail({ to: user.email, subject: `Reset your ${name} password`,
      text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\n${baseUrl(req)}/#/reset?token=${token}\n\nThis link expires in 1 hour. If you didn't ask for this, ignore this email.` })
      .catch((err) => console.error('[flipp] reset mail failed', err.message));
    await audit(req, 'auth.password_reset_requested', { user });
  }
  res.json({ ok: true }); // same answer whether or not the account exists
});

authRouter.post('/reset', limited, async (req, res) => {
  const pw = passwordField(req.body.password);
  const row = await consumeToken(req.body.token, 'reset');
  if (!row) throw httpError(400, 'This reset link is invalid or has expired');
  await db.run('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?', await hashPassword(pw), row.user_id);
  await db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id); // sign out everywhere
  await audit(req, 'auth.password_reset', { user: { id: row.user_id } });
  res.json({ ok: true });
});

// ---------- Email verification ----------
authRouter.post('/verify', limited, async (req, res) => {
  const row = await consumeToken(req.body.token, 'verify');
  if (!row) throw httpError(400, 'This confirmation link is invalid or has expired');
  await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', row.user_id);
  await audit(req, 'auth.email_verified', { user: { id: row.user_id } });
  const u = await db.get('SELECT totp_secret FROM users WHERE id = ?', row.user_id);
  if (u?.totp_secret) return res.json({ ok: true, login: true }); // never let an email link bypass 2FA
  await startSession(req, res, row.user_id, 'email');
  res.json({ ok: true });
});

authRouter.post('/verify/resend', rateLimit(3, 60_000), async (req, res) => {
  const e = String(req.body.email || '').trim().toLowerCase();
  const user = await db.get('SELECT id, email, name, email_verified FROM users WHERE email = ?', e);
  if (user && !user.email_verified && mailEnabled()) await sendVerification(req, user).catch((err) => console.error('[flipp] verify mail failed', err.message));
  res.json({ ok: true });
});

// ---------- Passkey sign-in (discoverable credentials, no username needed) ----------
const WEBAUTHN_COOKIE = 'flipp_webauthn';

authRouter.post('/passkey/options', limited, async (req, res) => {
  const { rpID } = rp(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  res.cookie(WEBAUTHN_COOKIE, sign({ purpose: 'passkey-login', challenge: options.challenge, exp: t() + 5 * 60_000 }), cookieOpts(req, { maxAge: 5 * 60_000 }));
  res.json(options);
});

authRouter.post('/passkey/verify', limited, async (req, res) => {
  const st = unsign(parseCookies(req.headers.cookie)[WEBAUTHN_COOKIE], 'passkey-login');
  res.clearCookie(WEBAUTHN_COOKIE, cookieOpts(req));
  if (!st) throw httpError(400, 'Passkey sign-in expired. Try again.');
  const credId = String(req.body?.id || '');
  const pk = await db.get('SELECT * FROM passkeys WHERE id = ?', credId);
  if (!pk) throw httpError(401, 'This passkey is not registered here');
  const { origin, rpID } = rp(req);
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: req.body, expectedChallenge: st.challenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: pk.id, publicKey: Buffer.from(pk.public_key, 'base64url'), counter: Number(pk.counter), transports: pk.transports ? pk.transports.split(',') : undefined },
    });
  } catch (e) {
    throw httpError(401, `Passkey verification failed: ${e.message}`);
  }
  if (!result.verified) throw httpError(401, 'Passkey verification failed');
  await db.run('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?', result.authenticationInfo.newCounter, t(), pk.id);
  const user = await db.get('SELECT id, email FROM users WHERE id = ?', pk.user_id);
  await audit(req, 'auth.login', { user, details: { method: 'passkey' } });
  await startSession(req, res, pk.user_id, 'passkey');
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
const redirectUri = (req) => `${baseUrl(req)}/api/auth/oidc/callback`;

authRouter.get('/oidc/login', limited, async (req, res) => {
  if (!oidc) throw httpError(404, 'OIDC is not configured');
  const cfg = await oidcConfig();
  const state = rand(), nonce = rand(), verifier = rand();
  const setup = typeof req.query.setup === 'string' ? req.query.setup : undefined; // first-run token, if completing setup via SSO
  res.cookie('flipp_oidc', sign({ state, nonce, verifier, setup, exp: t() + 600_000 }), cookieOpts(req, { maxAge: 600_000, path: '/api/auth/oidc' }));
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
  if (!st || st.state !== req.query.state || typeof req.query.code !== 'string') return fail('Invalid or expired login state');

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
  if (claims.iss !== cfg.issuer || !aud.includes(oidc.clientId) || claims.nonce !== st.nonce || claims.exp * 1000 < t() || !claims.sub) return fail('ID token validation failed');
  if (!claims.email && cfg.userinfo_endpoint && tokens.access_token) {
    const ui = await fetch(cfg.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (ui.ok) { const info = await ui.json(); if (info.sub === claims.sub) claims = { ...info, ...claims, email: info.email, email_verified: info.email_verified }; }
  }

  const sub = `${claims.iss}|${claims.sub}`;
  const mail = String(claims.email || `${claims.sub}@oidc.invalid`).toLowerCase();
  const isAdminByGroup = oidc.adminGroup && [].concat(claims.groups || []).includes(oidc.adminGroup);
  let user = await db.get('SELECT id, email FROM users WHERE oidc_sub = ?', sub);
  if (!user && claims.email && claims.email_verified === true) {
    user = await db.get('SELECT id, email FROM users WHERE email = ? AND oidc_sub IS NULL', mail); // link verified email to existing local account
    if (user) {
      // Whoever pre-registered this email (maybe not its owner) loses every other way in; the owner can set a password later.
      await db.tx(async (tx) => {
        await tx.run('UPDATE users SET oidc_sub = ?, email_verified = 1, password_hash = NULL, totp_secret = NULL, totp_last_step = NULL WHERE id = ?', sub, user.id);
        for (const table of ['passkeys', 'recovery_codes', 'sessions', 'tokens']) await tx.run(`DELETE FROM ${table} WHERE user_id = ?`, user.id);
      });
      await audit(req, 'auth.oidc_link', { user });
    }
  }
  if (!user) {
    const first = await needsSetup();
    if (first && !checkSetupToken(st.setup)) return fail('Finish setup first: open the setup link from the server logs.');
    if (!first && !oidc.allowSignup) return fail('No account for this identity. Ask an admin for access.');
    if (first) await completeSetup();
    try {
      user = await createUser({ email: mail, name: claims.name || claims.preferred_username, sub, role: first ? 'admin' : 'user', verified: claims.email_verified === true });
      user.email = mail;
    } catch (e) { return fail(e.message); }
    await audit(req, first ? 'auth.setup' : 'auth.register', { user, details: { method: 'oidc' } });
  }
  if (isAdminByGroup) await db.run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
  await audit(req, 'auth.login', { user, details: { method: 'oidc' } });
  await startSession(req, res, user.id, 'oidc');
  res.redirect('/#/');
});

export { oidc, PUBLIC_URL };
