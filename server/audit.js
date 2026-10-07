// Append-only audit trail of security-relevant actions. Viewable by admins; pruned after AUDIT_RETENTION_DAYS.
import { db } from './db.js';
import { now } from './util.js';

const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 365);

export async function audit(req, action, { target = '', details, user } = {}) {
  const u = user || req?.user;
  try {
    await db.run('INSERT INTO audit_log (ts, user_id, actor, ip, action, target, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      now(), u?.id ?? null, u?.email || '', req?.ip || '', action, String(target).slice(0, 300), details ? JSON.stringify(details).slice(0, 4000) : '');
  } catch (e) {
    console.error('[flipp] audit write failed', e); // never let auditing break the request
  }
}

export const pruneAudit = () => db.run('DELETE FROM audit_log WHERE ts < ?', now() - RETENTION_DAYS * 86_400_000);
