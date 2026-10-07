// Signed-in user's own account: profile, preferences, password, sessions, 2FA, passkeys, data export, deletion.
import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import qrcode from 'qrcode-generator';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { db, UPLOAD_DIR } from '../db.js';
import { httpError, now, rand, str, json, validTz, password as passwordField } from '../util.js';
import { cookieOpts, decrypt, encrypt, hashPassword, parseCookies, rateLimit, sign, tokenHash, unsign, verifyPassword, COOKIE } from '../auth.js';
import { audit } from '../audit.js';
import { newSecret, otpauthUrl, verifyTotp } from '../totp.js';
import { tarGzWriter } from '../archive.js';
import { rp } from './auth.js';
import { branding } from '../branding.js';
import { limitsFor, usage } from '../quota.js';
import { fitInWorker, countLongTerm, MIN_REVIEWS } from '../optimizer.js';

export const accountRouter = Router();
// Routes that check a password or code: a stolen session must not become a guessing oracle.
const guessLimit = rateLimit(10, 15 * 60_000, (req) => `user:${req.user.id}`);
const RECENT_LOGIN = 10 * 60_000;

// Sensitive changes need proof of presence: current password, else a TOTP code, else (SSO-only accounts) the typed email.
async function reauth(req, body) {
  const u = await db.get('SELECT email, password_hash, totp_secret, totp_last_step FROM users WHERE id = ?', req.user.id);
  if (u.password_hash) {
    if (!(await verifyPassword(String(body.password || ''), u.password_hash))) throw httpError(401, 'Current password is wrong');
  } else if (u.totp_secret) {
    if (verifyTotp(decrypt(u.totp_secret), body.code, { lastStep: u.totp_last_step ?? -1 }) === null) throw httpError(401, 'Invalid code');
  } else if (String(body.confirm || '').trim().toLowerCase() !== u.email) throw httpError(401, 'Type your email address to confirm');
}

// ---------- Profile & preferences ----------
accountRouter.put('/me', async (req, res) => {
  await db.run('UPDATE users SET name = ? WHERE id = ?', str(req.body.name, 80, { min: 1 }), req.user.id);
  res.json({ ok: true });
});

// Server-side prefs (used by reminders / day boundaries). Client-only prefs (sound, theme) stay in localStorage.
accountRouter.get('/prefs', async (req, res) => {
  const row = await db.get('SELECT prefs FROM users WHERE id = ?', req.user.id);
  res.json(json(row.prefs, {}));
});
accountRouter.put('/prefs', async (req, res) => {
  const row = await db.get('SELECT prefs FROM users WHERE id = ?', req.user.id);
  const p = json(row.prefs, {});
  const b = req.body || {};
  if (b.tz !== undefined) { if (typeof b.tz !== 'string' || !validTz(b.tz)) throw httpError(400, 'Unknown timezone'); p.tz = b.tz; }
  if (b.reminder !== undefined) {
    if (b.reminder !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.reminder)) throw httpError(400, 'Reminder must be HH:MM');
    p.reminder = b.reminder;
  }
  if (b.dailyGoal !== undefined) p.dailyGoal = Math.max(0, Math.min(1000, Math.round(Number(b.dailyGoal) || 0)));
  await db.run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(p), req.user.id);
  res.json(p);
});

accountRouter.post('/password', guessLimit, async (req, res) => {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (row.password_hash && !(await verifyPassword(String(req.body.current || ''), row.password_hash))) throw httpError(401, 'Current password is wrong');
  // SSO-only accounts have nothing to re-enter, so a first password needs a fresh sign-in instead.
  if (!row.password_hash && now() - req.session.createdAt > RECENT_LOGIN) throw httpError(403, 'Sign in again to set a password', { code: 'reauth_required' });
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(passwordField(req.body.password)), req.user.id);
  // Changing the password signs out every other device.
  await db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', req.user.id, req.session.id);
  await audit(req, 'account.password_changed');
  res.json({ ok: true });
});

// ---------- Security overview & sessions ----------
accountRouter.get('/security', async (req, res) => {
  const u = await db.get('SELECT password_hash IS NOT NULL AS has_password, totp_secret IS NOT NULL AS has_totp, oidc_sub IS NOT NULL AS sso FROM users WHERE id = ?', req.user.id);
  const codes = await db.get('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', req.user.id);
  const passkeys = await db.all('SELECT id, name, created_at, last_used FROM passkeys WHERE user_id = ? ORDER BY created_at', req.user.id);
  const sessions = await db.all('SELECT id, created_at, last_seen, ip, user_agent, method FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC', req.user.id, now());
  res.json({
    hasPassword: !!u.has_password, hasTotp: !!u.has_totp, sso: !!u.sso, recoveryCodesLeft: Number(codes.n), passkeys,
    sessions: sessions.map((s) => ({ ...s, current: s.id === req.session.id })),
    mfaSetupRequired: !!req.user.mfaSetupRequired,
  });
});

accountRouter.delete('/security/sessions/:id', async (req, res) => {
  const r = await db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', String(req.params.id), req.user.id);
  if (!r.changes) throw httpError(404, 'Session not found');
  await audit(req, 'account.session_revoked', { target: req.params.id });
  res.json({ ok: true });
});
accountRouter.post('/security/sessions/revoke-others', async (req, res) => {
  const r = await db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', req.user.id, req.session.id);
  await audit(req, 'account.sessions_revoked', { details: { count: r.changes } });
  res.json({ ok: true, revoked: r.changes });
});

// ---------- TOTP ----------
const recoveryCodes = () => Array.from({ length: 10 }, () => rand(6).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 8).replace(/^(.{4})/, '$1-'));
async function storeRecoveryCodes(userId) {
  const codes = recoveryCodes();
  await db.run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
  for (const c of codes) await db.run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, tokenHash(c.replace(/[\s-]/g, '')));
  return codes;
}

accountRouter.post('/totp/setup', async (req, res) => {
  if (req.user.hasTotp) throw httpError(409, 'Two-factor authentication is already enabled');
  const secret = newSecret();
  const url = otpauthUrl(secret, req.user.email, (await branding()).name);
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  // The pending secret travels in a signed ticket; nothing is stored until a valid code proves the app is set up.
  res.json({ secret, url, qr: qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }), ticket: sign({ purpose: 'totp-setup', uid: req.user.id, secret: encrypt(secret), exp: now() + 15 * 60_000 }) });
});

accountRouter.post('/totp/enable', async (req, res) => {
  const t = unsign(req.body.ticket, 'totp-setup');
  if (!t || t.uid !== req.user.id) throw httpError(400, 'Setup expired. Start again.');
  const secret = decrypt(t.secret);
  const step = verifyTotp(secret, req.body.code);
  if (step === null) throw httpError(400, "That code didn't match. Check your phone's clock and try again.");
  const r = await db.run('UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ? AND totp_secret IS NULL', encrypt(secret), step, req.user.id);
  if (!r.changes) throw httpError(409, 'Two-factor authentication is already enabled');
  const codes = await storeRecoveryCodes(req.user.id);
  // Upgrade this session so a 2FA-required admin is no longer restricted.
  await db.run("UPDATE sessions SET method = 'totp' WHERE id = ?", req.session.id);
  await audit(req, 'account.totp_enabled');
  res.json({ ok: true, recoveryCodes: codes });
});

accountRouter.post('/totp/disable', guessLimit, async (req, res) => {
  const u = await db.get('SELECT totp_secret, totp_last_step, password_hash FROM users WHERE id = ?', req.user.id);
  if (!u.totp_secret) throw httpError(409, 'Two-factor authentication is not enabled');
  if (verifyTotp(decrypt(u.totp_secret), req.body.code, { lastStep: u.totp_last_step ?? -1 }) === null) throw httpError(401, 'Invalid code');
  if (u.password_hash && !(await verifyPassword(String(req.body.password || ''), u.password_hash))) throw httpError(401, 'Current password is wrong');
  await db.run('UPDATE users SET totp_secret = NULL, totp_last_step = NULL WHERE id = ?', req.user.id);
  await db.run('DELETE FROM recovery_codes WHERE user_id = ?', req.user.id);
  await audit(req, 'account.totp_disabled');
  res.json({ ok: true });
});

accountRouter.post('/totp/recovery-codes', guessLimit, async (req, res) => {
  const u = await db.get('SELECT totp_secret, totp_last_step FROM users WHERE id = ?', req.user.id);
  if (!u.totp_secret) throw httpError(409, 'Two-factor authentication is not enabled');
  const step = verifyTotp(decrypt(u.totp_secret), req.body.code, { lastStep: u.totp_last_step ?? -1 });
  if (step === null) throw httpError(401, 'Invalid code');
  await db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, req.user.id);
  const codes = await storeRecoveryCodes(req.user.id);
  await audit(req, 'account.recovery_codes_regenerated');
  res.json({ recoveryCodes: codes });
});

// ---------- Passkeys ----------
const WEBAUTHN_COOKIE = 'flipp_webauthn_reg';

accountRouter.post('/passkeys/options', async (req, res) => {
  const { rpID } = rp(req);
  const existing = await db.all('SELECT id, transports FROM passkeys WHERE user_id = ?', req.user.id);
  const options = await generateRegistrationOptions({
    rpName: (await branding()).name, rpID, userName: req.user.email, userDisplayName: req.user.name || req.user.email,
    userID: Buffer.from(`flipp-user-${req.user.id}`), attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? p.transports.split(',') : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  res.cookie(WEBAUTHN_COOKIE, sign({ purpose: 'passkey-register', uid: req.user.id, challenge: options.challenge, exp: now() + 5 * 60_000 }), cookieOpts(req, { maxAge: 5 * 60_000 }));
  res.json(options);
});

accountRouter.post('/passkeys/verify', async (req, res) => {
  const st = unsign(parseCookies(req.headers.cookie)[WEBAUTHN_COOKIE], 'passkey-register');
  res.clearCookie(WEBAUTHN_COOKIE, cookieOpts(req));
  if (!st || st.uid !== req.user.id) throw httpError(400, 'Passkey setup expired. Try again.');
  const { origin, rpID } = rp(req);
  let result;
  try {
    result = await verifyRegistrationResponse({ response: req.body.response, expectedChallenge: st.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  } catch (e) {
    throw httpError(400, `Passkey registration failed: ${e.message}`);
  }
  if (!result.verified) throw httpError(400, 'Passkey registration failed');
  const { credential } = result.registrationInfo;
  const name = str(req.body.name || 'Passkey', 60, { min: 1 });
  await db.run('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    credential.id, req.user.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter, (credential.transports || []).join(','), name, now());
  await audit(req, 'account.passkey_added', { target: name });
  res.json({ ok: true });
});

accountRouter.patch('/passkeys/:id', async (req, res) => {
  const r = await db.run('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?', str(req.body.name, 60, { min: 1 }), String(req.params.id), req.user.id);
  if (!r.changes) throw httpError(404, 'Passkey not found');
  res.json({ ok: true });
});
accountRouter.delete('/passkeys/:id', async (req, res) => {
  const r = await db.run('DELETE FROM passkeys WHERE id = ? AND user_id = ?', String(req.params.id), req.user.id);
  if (!r.changes) throw httpError(404, 'Passkey not found');
  await audit(req, 'account.passkey_removed', { target: req.params.id });
  res.json({ ok: true });
});

// ---------- Quota usage ----------
accountRouter.get('/usage', async (req, res) => res.json({ usage: await usage(req.user.id), limits: await limitsFor(req.user.id) }));

// ---------- Data export (everything the user owns or created) ----------
accountRouter.get('/export', async (req, res) => {
  const uid = req.user.id;
  const user = await db.get('SELECT id, email, name, role, created_at, prefs FROM users WHERE id = ?', uid);
  const courses = await db.all('SELECT * FROM courses WHERE owner_id = ?', uid);
  const courseIds = courses.map((c) => c.id);
  const inList = (ids) => (ids.length ? ids.join(',') : 'NULL'); // ids are integers from our own DB
  const sets = await db.all(`SELECT * FROM sets WHERE course_id IN (${inList(courseIds)})`);
  const cards = await db.all(`SELECT * FROM cards WHERE set_id IN (${inList(sets.map((s) => s.id))})`);
  const data = {
    format: 'flipp-user-export', version: 1, exported_at: new Date().toISOString(),
    user: { ...user, prefs: json(user.prefs, {}) },
    courses, sets, cards,
    progress: await db.all('SELECT * FROM progress WHERE user_id = ?', uid),
    reviews: await db.all('SELECT id, card_id, variant, rating, state, was_new, ts FROM reviews WHERE user_id = ?', uid),
    stars: await db.all('SELECT card_id FROM stars WHERE user_id = ?', uid),
    course_prefs: await db.all('SELECT course_id, prefs FROM course_prefs WHERE user_id = ?', uid),
    match_scores: await db.all('SELECT set_id, ms, created_at FROM match_scores WHERE user_id = ?', uid),
    activity: await db.all('SELECT day, xp, stats, frozen FROM activity WHERE user_id = ?', uid),
    groups: await db.all('SELECT g.id, g.name, gm.role, gm.joined_at FROM group_members gm JOIN study_groups g ON g.id = gm.group_id WHERE gm.user_id = ?', uid),
    passkeys: await db.all('SELECT name, created_at, last_used FROM passkeys WHERE user_id = ?', uid),
  };
  const files = await db.all('SELECT name FROM uploads WHERE user_id = ?', uid);
  await audit(req, 'account.data_exported');
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="flipp-export-${new Date().toISOString().slice(0, 10)}.tar.gz"` });
  const w = tarGzWriter(res);
  await w.addBuffer('data.json', Buffer.from(JSON.stringify(data, null, 2)));
  for (const f of files) {
    const p = path.join(UPLOAD_DIR, path.basename(f.name));
    if (fs.existsSync(p)) await w.addFile(`uploads/${path.basename(f.name)}`, p);
  }
  await w.finish();
});

// ---------- Delete own account ----------
accountRouter.delete('/', guessLimit, async (req, res) => {
  await reauth(req, req.body || {});
  if (req.user.role === 'admin') {
    const admins = await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
    if (Number(admins.n) <= 1) throw httpError(400, 'You are the only admin. Promote someone else first.');
  }
  await audit(req, 'account.deleted', { target: req.user.email });
  await db.run('DELETE FROM users WHERE id = ?', req.user.id); // cascades to courses, progress, sessions, …
  res.clearCookie(COOKIE, cookieOpts(req)).json({ ok: true });
});

// ---------- Scheduler optimization (fit FSRS weights to this user's history) ----------
let optimizing = false;
accountRouter.get('/optimizer', async (req, res) => {
  const row = await db.get('SELECT fsrs_params FROM users WHERE id = ?', req.user.id);
  const reviews = await db.get('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ?', req.user.id);
  res.json({ current: json(row.fsrs_params, null), reviews: Number(reviews.n), minimum: MIN_REVIEWS });
});

accountRouter.post('/optimizer', async (req, res) => {
  if (optimizing) throw httpError(429, 'Another optimization is running. Try again in a minute.');
  const rows = await db.all('SELECT card_id, variant, rating, ts FROM reviews WHERE user_id = ? ORDER BY card_id, variant, ts', req.user.id);
  const byKey = new Map();
  for (const r of rows.slice(-40000)) { const k = `${r.card_id}:${r.variant}`; (byKey.get(k) || byKey.set(k, []).get(k)).push({ ts: Number(r.ts), rating: r.rating }); }
  const sequences = [...byKey.values()].filter((s) => s.length > 1);
  const usable = countLongTerm(sequences);
  if (usable < MIN_REVIEWS) throw httpError(400, `Not enough history yet: ${usable} of ${MIN_REVIEWS} reviews spaced at least a day apart.`);
  optimizing = true;
  let result;
  try { result = await fitInWorker(sequences); } finally { optimizing = false; }
  if (result.improved) {
    await db.run('UPDATE users SET fsrs_params = ? WHERE id = ?', JSON.stringify({ w: result.w, optimizedAt: now(), reviews: usable, before: result.before, after: result.after }), req.user.id);
  }
  await audit(req, 'account.scheduler_optimized', { details: { reviews: usable, improved: result.improved } });
  res.json({ ...result, reviews: usable });
});

accountRouter.delete('/optimizer', async (req, res) => {
  await db.run('UPDATE users SET fsrs_params = NULL WHERE id = ?', req.user.id);
  res.json({ ok: true });
});
