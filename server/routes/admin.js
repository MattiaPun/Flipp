// Instance administration: users & roles, registration/security settings, invites, audit log,
// storage cleanup and backups.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, getSetting, setSetting, DATA_DIR, BACKUP_DIR, isPg } from '../db.js';
import { createBackup, listBackups, getSchedule, setSchedule, backupPath, restoreBackup, endMaintenance } from '../backup.js';
import { httpError, id, now, str, email as emailField, password as passwordField } from '../util.js';
import { requireAdmin, registrationOpen, hashPassword, baseUrl } from '../auth.js';
import { audit } from '../audit.js';
import { scanUploads, cleanupOrphans } from '../storage.js';
import { mailEnabled, sendMail } from '../mailer.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const ROLES = ['user', 'admin'];

adminRouter.get('/overview', async (_req, res) => {
  const count = async (sql) => Number((await db.get(sql)).n);
  const dbFile = path.join(DATA_DIR, 'Flipp.db');
  res.json({
    users: await count('SELECT COUNT(*) AS n FROM users'),
    courses: await count('SELECT COUNT(*) AS n FROM courses'),
    cards: await count('SELECT COUNT(*) AS n FROM cards'),
    reviews: await count('SELECT COUNT(*) AS n FROM reviews'),
    reviews7d: Number((await db.get('SELECT COUNT(*) AS n FROM reviews WHERE ts > ?', now() - 7 * 86_400_000)).n),
    storageBytes: Number((await db.get('SELECT COALESCE(SUM(size), 0) AS n FROM uploads')).n),
    dbBytes: !isPg && fs.existsSync(dbFile) ? fs.statSync(dbFile).size : null,
    database: isPg ? 'postgres' : 'sqlite',
    mail: mailEnabled(),
  });
});

// ---------- Users ----------
adminRouter.get('/users', async (_req, res) => {
  const users = await db.all(`SELECT id, email, name, role, created_at, oidc_sub IS NOT NULL AS sso, totp_secret IS NOT NULL AS totp,
    password_hash IS NOT NULL AS has_password, email_verified,
    (SELECT COUNT(*) FROM courses c WHERE c.owner_id = users.id) AS courses,
    (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = users.id) AS last_seen,
    (SELECT COUNT(*) FROM passkeys pk WHERE pk.user_id = users.id) AS passkeys,
    (SELECT COALESCE(SUM(size), 0) FROM uploads up WHERE up.user_id = users.id) AS storage
    FROM users ORDER BY id`);
  res.json(users.map((u) => ({ ...u, sso: !!u.sso, totp: !!u.totp, has_password: !!u.has_password, storage: Number(u.storage) })));
});

adminRouter.post('/users', async (req, res) => {
  const e = emailField(req.body.email);
  if (await db.get('SELECT id FROM users WHERE email = ?', e)) throw httpError(409, 'Email already in use');
  const role = ROLES.includes(req.body.role) ? req.body.role : 'user';
  await db.run('INSERT INTO users (email, name, password_hash, role, email_verified, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    e, str(req.body.name || e.split('@')[0], 80), await hashPassword(passwordField(req.body.password)), role, now());
  await audit(req, 'admin.user_created', { target: e, details: { role } });
  res.json({ ok: true });
});

adminRouter.put('/users/:id', async (req, res) => {
  const uid = id(req.params.id);
  const u = await db.get('SELECT id, email, role FROM users WHERE id = ?', uid);
  if (!u) throw httpError(404, 'User not found');
  if (req.body.role !== undefined) {
    if (uid === req.user.id) throw httpError(400, "You can't change your own role");
    if (!ROLES.includes(req.body.role)) throw httpError(400, 'Unknown role');
    await db.run('UPDATE users SET role = ? WHERE id = ?', req.body.role, uid);
    await audit(req, 'admin.role_changed', { target: u.email, details: { from: u.role, to: req.body.role } });
  }
  res.json({ ok: true });
});

adminRouter.delete('/users/:id', async (req, res) => {
  const uid = id(req.params.id);
  if (uid === req.user.id) throw httpError(400, "You can't delete yourself here. Use Settings → Delete account.");
  const u = await db.get('SELECT email FROM users WHERE id = ?', uid);
  if (!u) throw httpError(404, 'User not found');
  await db.run('DELETE FROM users WHERE id = ?', uid);
  await audit(req, 'admin.user_deleted', { target: u.email });
  res.json({ ok: true });
});

// Lost phone: admin removes a user's 2FA + recovery codes (and signs them out).
adminRouter.post('/users/:id/reset-2fa', async (req, res) => {
  const uid = id(req.params.id);
  const u = await db.get('SELECT email FROM users WHERE id = ?', uid);
  if (!u) throw httpError(404, 'User not found');
  await db.run('UPDATE users SET totp_secret = NULL, totp_last_step = NULL WHERE id = ?', uid);
  await db.run('DELETE FROM recovery_codes WHERE user_id = ?', uid);
  await db.run('DELETE FROM sessions WHERE user_id = ?', uid);
  await audit(req, 'admin.2fa_reset', { target: u.email });
  res.json({ ok: true });
});

adminRouter.post('/users/:id/logout', async (req, res) => {
  const uid = id(req.params.id);
  const r = await db.run('DELETE FROM sessions WHERE user_id = ?', uid);
  await audit(req, 'admin.user_signed_out', { target: `user:${uid}`, details: { sessions: r.changes } });
  res.json({ ok: true });
});

// ---------- Settings ----------
adminRouter.get('/settings', async (_req, res) => {
  res.json({
    allowRegistration: await registrationOpen(),
    require2faAdmins: (await getSetting('require_2fa_admins')) === 'true',
    requireEmailVerification: (await getSetting('require_email_verification')) === 'true',
    mail: mailEnabled(),
    invites: await db.all('SELECT i.code, i.expires_at, u.email AS used_by_email FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.expires_at DESC LIMIT 50'),
  });
});

adminRouter.put('/settings', async (req, res) => {
  const b = req.body || {};
  const changed = {};
  if (b.allowRegistration !== undefined) { await setSetting('allow_registration', b.allowRegistration ? 'true' : 'false'); changed.allowRegistration = !!b.allowRegistration; }
  if (b.require2faAdmins !== undefined) {
    if (b.require2faAdmins && !req.user.hasTotp) throw httpError(400, 'Enable two-factor authentication on your own account first');
    await setSetting('require_2fa_admins', b.require2faAdmins ? 'true' : 'false'); changed.require2faAdmins = !!b.require2faAdmins;
  }
  if (b.requireEmailVerification !== undefined) {
    if (b.requireEmailVerification && !mailEnabled()) throw httpError(400, 'Configure SMTP_URL first');
    await setSetting('require_email_verification', b.requireEmailVerification ? 'true' : 'false'); changed.requireEmailVerification = !!b.requireEmailVerification;
  }
  await audit(req, 'admin.settings_changed', { details: changed });
  res.json({ ok: true });
});

// ---------- Invites ----------
adminRouter.post('/invites', async (req, res) => {
  const code = crypto.randomBytes(12).toString('base64url');
  await db.run('INSERT INTO invites (code, created_by, expires_at) VALUES (?, ?, ?)', code, req.user.id, now() + 7 * 86_400_000);
  const link = `${baseUrl(req)}/#/register?invite=${code}`;
  let emailed = false;
  if (req.body?.email) {
    const to = emailField(req.body.email);
    await sendMail({ to, subject: "You're invited to Flipp", text: `${req.user.name} invited you to Flipp.\n\nCreate your account here (valid for 7 days):\n\n${link}` });
    emailed = true;
  }
  await audit(req, 'admin.invite_created', { details: { emailed, to: req.body?.email || undefined } });
  res.json({ code, link, emailed });
});
adminRouter.delete('/invites/:code', async (req, res) => {
  await db.run('DELETE FROM invites WHERE code = ?', String(req.params.code));
  await audit(req, 'admin.invite_deleted');
  res.json({ ok: true });
});

// ---------- Audit log ----------
adminRouter.get('/audit', async (req, res) => {
  const where = [], params = [];
  if (req.query.action) { where.push('action LIKE ?'); params.push(`${String(req.query.action).slice(0, 60)}%`); }
  if (req.query.q) { where.push('(LOWER(actor) LIKE ? OR LOWER(target) LIKE ? OR ip LIKE ?)'); const q = `%${String(req.query.q).toLowerCase().slice(0, 100)}%`; params.push(q, q, q); }
  if (req.query.before) { where.push('id < ?'); params.push(Number(req.query.before) || 0); }
  const rows = await db.all(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`, ...params);
  res.json(rows);
});

// ---------- Storage ----------
adminRouter.get('/storage', async (_req, res) => {
  const scan = await scanUploads();
  const perUser = await db.all(`SELECT u.id, u.email, u.name, COALESCE(SUM(up.size), 0) AS bytes, COUNT(up.name) AS files
    FROM users u LEFT JOIN uploads up ON up.user_id = u.id GROUP BY u.id, u.email, u.name ORDER BY bytes DESC`);
  res.json({ files: scan.files, orphans: scan.orphans.length, orphanBytes: scan.orphanBytes, perUser: perUser.map((r) => ({ ...r, bytes: Number(r.bytes), files: Number(r.files) })) });
});
adminRouter.post('/storage/cleanup', async (req, res) => {
  const r = await cleanupOrphans();
  await audit(req, 'admin.storage_cleanup', { details: r });
  res.json(r);
});

// ---------- Backups ----------
adminRouter.get('/backups', async (_req, res) => res.json({ files: await listBackups(), schedule: await getSchedule(), dir: BACKUP_DIR }));

adminRouter.post('/backups', async (req, res) => {
  const r = await createBackup('manual');
  await audit(req, 'backup.created', { target: r.name, details: r.counts });
  res.json(r);
});

adminRouter.put('/backups/schedule', async (req, res) => {
  const s = await setSchedule(req.body || {});
  await audit(req, 'backup.schedule_changed', { details: s });
  res.json(s);
});

adminRouter.get('/backups/:name', async (req, res) => {
  const p = backupPath(String(req.params.name));
  if (!p) throw httpError(404, 'Backup not found');
  await audit(req, 'backup.downloaded', { target: req.params.name });
  res.download(p, req.params.name);
});

adminRouter.delete('/backups/:name', async (req, res) => {
  const p = backupPath(String(req.params.name));
  if (!p) throw httpError(404, 'Backup not found');
  await fs.promises.rm(p);
  await audit(req, 'backup.deleted', { target: req.params.name });
  res.json({ ok: true });
});

async function runRestore(req, res, file, label) {
  if (req.get('x-confirm') !== 'RESTORE' && req.body?.confirm !== 'RESTORE') throw httpError(400, 'Type RESTORE to confirm');
  await audit(req, 'backup.restore_started', { target: label });
  try {
    await restoreBackup(file);
  } catch (e) {
    endMaintenance();
    await audit(req, 'backup.restore_failed', { target: label, details: { error: e.message } });
    throw httpError(400, `Restore failed, nothing was changed: ${e.message}`);
  }
  await audit(req, 'backup.restored', { target: label });
  res.json({ ok: true, restarting: true });
  // Secrets, caches and the setup state were replaced: restart cleanly (Docker's restart policy brings us back).
  console.log('[flipp] Restore complete, restarting.');
  if (process.env.FLIPP_NO_LISTEN === '1') endMaintenance(); // embedded (tests): no restart
  else setTimeout(() => process.exit(0), 500);
}

adminRouter.post('/backups/:name/restore', async (req, res) => {
  const p = backupPath(String(req.params.name));
  if (!p) throw httpError(404, 'Backup not found');
  await runRestore(req, res, p, req.params.name);
});

// Upload a backup file (streamed to disk), then restore it.
adminRouter.post('/backups-upload', async (req, res) => {
  if (req.get('x-confirm') !== 'RESTORE') throw httpError(400, 'Type RESTORE to confirm');
  const name = `flipp-upload-${new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '')}.tar.gz`;
  const dest = path.join(BACKUP_DIR, name);
  const max = Number(process.env.MAX_RESTORE_MB || 4096) * 1048576;
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); out.destroy(); reject(httpError(413, 'Backup too large')); } });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  }).catch(async (e) => { await fs.promises.rm(dest, { force: true }); throw e; });
  await runRestore(req, res, dest, name);
});
