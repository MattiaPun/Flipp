// Background jobs on a one-minute tick: daily maintenance (instance timezone), scheduled backups, reminders.
import { pruneAudit } from './audit.js';
import { cleanupOrphans } from './storage.js';
import { db, getSetting, setSetting } from './db.js';
import { zonedParts, INSTANCE_TZ, now } from './util.js';
import { createBackup, pruneBackups, getSchedule, maintenance } from './backup.js';

const tasks = []; // { name, everyMinute(parts) }
export const registerJob = (name, fn) => tasks.push({ name, fn });

// Runs `fn` at most once per local day, at or after `minuteOfDay`.
export const daily = (key, minuteOfDay, fn) => async (p) => {
  if (p.minutes < minuteOfDay) return;
  const last = await getSetting(`job_${key}`);
  if (last === p.date) return;
  await setSetting(`job_${key}`, p.date);
  await fn(p);
};

registerJob('maintenance', daily('maintenance', 3 * 60, async () => {
  await pruneAudit();
  await db.run('DELETE FROM sessions WHERE expires_at < ?', now());
  await db.run('DELETE FROM tokens WHERE expires_at < ?', now());
  await cleanupOrphans();
}));

// Scheduled backups at the configured local hour.
registerJob('backups', async (p) => {
  const s = await getSchedule();
  if (!s.enabled) return;
  await daily('backup', s.hour * 60, async () => {
    const r = await createBackup('auto');
    await pruneBackups(s.keep);
    console.log(`[flipp] Scheduled backup written: ${r.name}`);
  })(p);
});

let running = false;
export async function tick() {
  if (running || maintenance) return; // a restore is rewriting the database underneath us
  running = true;
  const p = zonedParts(now(), INSTANCE_TZ);
  for (const t of tasks) {
    try { await t.fn(p); } catch (e) { console.error(`[flipp] job ${t.name} failed`, e); }
  }
  running = false;
}

export function startJobs() {
  setTimeout(tick, 5_000).unref();
  setInterval(tick, 60_000).unref();
}
