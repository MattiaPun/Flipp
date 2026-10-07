// Portable instance backups: every table as JSON-lines chunks + all uploads, in one .tar.gz.
// Works identically on SQLite and PostgreSQL, so a restore can also move an instance between them.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, isPg, TABLES, SCHEMA_VERSION, BACKUP_DIR, UPLOAD_DIR, getJsonSetting, setSetting } from './db.js';
import { tarGzWriter, readTarGz } from './archive.js';
import { now } from './util.js';
import { resetBrandingCache } from './branding.js';

const CHUNK = 5000;
const SERIAL_TABLES = ['users', 'courses', 'sets', 'cards', 'reviews', 'match_scores', 'study_groups', 'assignments', 'audit_log'];
export const BACKUP_NAME = /^flipp-(auto|manual|upload)-[0-9TZ_.-]+\.tar\.gz$/;
const stamp = () => new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');

// Primary key columns per table, for stable pagination.
const ORDER = {
  settings: 'key', users: 'id', invites: 'code', courses: 'id', sets: 'id', cards: 'id', progress: 'user_id, card_id, variant',
  stars: 'user_id, card_id', reviews: 'id', match_scores: 'id', course_prefs: 'user_id, course_id', saved_courses: 'user_id, course_id',
  course_members: 'course_id, user_id', study_groups: 'id', group_members: 'group_id, user_id', group_courses: 'group_id, course_id',
  assignments: 'id', recovery_codes: 'user_id, code_hash', passkeys: 'id', audit_log: 'id', uploads: 'name', push_subscriptions: 'endpoint',
  activity: 'user_id, day',
};

// Maintenance mode blocks all other API traffic while a restore rewrites the database.
export let maintenance = false;

// Runs fn(reader) against one consistent view of the database, so rows written mid-dump can't tear the backup.
async function snapshot(fn) {
  if (isPg) {
    return db.tx(async (t) => {
      await t.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return fn(t);
    });
  }
  // SQLite has a single shared connection, so copy the database aside instead of holding a transaction open.
  const file = path.join(BACKUP_DIR, `.snapshot-${Date.now()}-${process.pid}.db`);
  await db.run('VACUUM INTO ?', file);
  const { DatabaseSync } = await import('node:sqlite');
  const snap = new DatabaseSync(file, { readOnly: true });
  try {
    return await fn({ all: async (sql) => snap.prepare(sql).all() });
  } finally {
    snap.close();
    await fsp.rm(file, { force: true });
  }
}

export async function createBackup(kind = 'manual') {
  const name = `flipp-${kind}-${stamp()}.tar.gz`;
  const tmp = path.join(BACKUP_DIR, `.${name}.part`);
  const out = fs.createWriteStream(tmp);
  const w = tarGzWriter(out);
  const counts = {};
  try {
    await w.addBuffer('manifest.json', Buffer.from(JSON.stringify({
      format: 'flipp-backup', version: 1, schema_version: SCHEMA_VERSION, created_at: new Date().toISOString(), source: isPg ? 'postgres' : 'sqlite', tables: TABLES,
    }, null, 2)));
    await snapshot(async (snap) => {
      for (const table of TABLES) {
        counts[table] = 0;
        for (let offset = 0, part = 0; ; offset += CHUNK, part++) {
          const rows = await snap.all(`SELECT * FROM ${table} ORDER BY ${ORDER[table]} LIMIT ${CHUNK} OFFSET ${offset}`);
          if (!rows.length) break;
          counts[table] += rows.length;
          await w.addBuffer(`db/${table}.${String(part).padStart(5, '0')}.jsonl`, Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n')));
          if (rows.length < CHUNK) break;
        }
      }
    });
    for (const f of await fsp.readdir(UPLOAD_DIR)) {
      if (/^[a-f0-9]{32}\.[a-z0-9]{3,4}$/.test(f)) await w.addFile(`uploads/${f}`, path.join(UPLOAD_DIR, f));
    }
    await w.finish();
    await fsp.rename(tmp, path.join(BACKUP_DIR, name));
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  return { name, counts };
}

export async function listBackups() {
  const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => BACKUP_NAME.test(f));
  const out = [];
  for (const f of files) {
    const st = await fsp.stat(path.join(BACKUP_DIR, f));
    out.push({ name: f, size: st.size, created: st.mtimeMs, kind: f.split('-')[1] });
  }
  return out.sort((a, b) => b.created - a.created);
}

export async function pruneBackups(keep) {
  const autos = (await listBackups()).filter((b) => b.kind === 'auto');
  for (const b of autos.slice(Math.max(1, keep))) await fsp.rm(path.join(BACKUP_DIR, b.name), { force: true });
}

export const backupPath = (name) => {
  if (!BACKUP_NAME.test(name)) return null;
  const p = path.join(BACKUP_DIR, name);
  return fs.existsSync(p) ? p : null;
};

export const getSchedule = async () => ({ enabled: false, hour: 3, keep: 7, ...(await getJsonSetting('backup_schedule', {})) });
export async function setSchedule(s) {
  const next = { enabled: !!s.enabled, hour: Math.max(0, Math.min(23, Math.round(Number(s.hour) || 0))), keep: Math.max(1, Math.min(365, Math.round(Number(s.keep) || 7))) };
  await setSetting('backup_schedule', JSON.stringify(next));
  return next;
}

const SAFE_COL = /^[a-z_][a-z0-9_]*$/;
const RESTORE_MAX = Number(process.env.MAX_RESTORE_MB || 4096) * 1048576;

// Restores a backup file in place. Everything is replaced; all sessions end.
export async function restoreBackup(file) {
  const work = path.join(BACKUP_DIR, `.restore-${Date.now()}`);
  const newUploads = path.join(work, 'uploads');
  await fsp.mkdir(newUploads, { recursive: true });
  try {
    // Pass 1: unpack and validate outside the transaction.
    // Rows are parsed into memory here so the transaction below does no file I/O.
    // ponytail: the whole database is held in memory during a restore; stream per chunk if instances outgrow RAM.
    let manifest = null;
    const chunks = [];
    // Uploads go to disk, so the unpacked cap can be well above the compressed upload limit.
    for await (const e of readTarGz(fs.createReadStream(file), { maxTotalBytes: 4 * RESTORE_MAX, maxEntries: 1_000_000 })) {
      if (e.name === 'manifest.json') manifest = JSON.parse(e.data.toString());
      else if (/^db\/[a-z_]+\.\d{5}\.jsonl$/.test(e.name)) {
        const table = e.name.split('/')[1].split('.')[0];
        if (!TABLES.includes(table)) throw new Error(`Unknown table in backup: ${table}`);
        const rows = e.data.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        for (const row of rows) if (!Object.keys(row).length || !Object.keys(row).every((c) => SAFE_COL.test(c))) throw new Error(`Bad column in ${table}`);
        chunks.push({ table, name: e.name, rows });
      } else if (/^uploads\/[a-f0-9]{32}\.[a-z0-9]{3,4}$/.test(e.name)) {
        await fsp.writeFile(path.join(newUploads, path.basename(e.name)), e.data);
      }
    }
    if (manifest?.format !== 'flipp-backup') throw new Error('Not a Flipp backup');
    if (manifest.schema_version !== SCHEMA_VERSION) {
      throw new Error(`This backup is from database schema v${manifest.schema_version}; this server runs v${SCHEMA_VERSION}. Restore it with the matching Flipp version.`);
    }
    if (!chunks.some((c) => c.table === 'users')) throw new Error('Backup contains no users');
    if (!chunks.some((c) => c.table === 'settings' && c.rows.some((r) => r.key === 'schema_version'))) throw new Error('Backup has no schema_version setting');
    chunks.sort((a, b) => TABLES.indexOf(a.table) - TABLES.indexOf(b.table) || a.name.localeCompare(b.name));

    // Pass 2: replace all rows in one transaction.
    maintenance = true;
    await db.tx(async (t) => {
      await t.run('DELETE FROM sessions');
      await t.run('DELETE FROM tokens');
      for (const table of [...TABLES].reverse()) await t.run(`DELETE FROM ${table}`);
      for (const { table, rows } of chunks) {
        for (const row of rows) {
          const cols = Object.keys(row);
          await t.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
        }
      }
      // Never let a backup roll back the migration state or reopen first-run setup.
      const upsert = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
      await t.run(upsert, 'schema_version', String(SCHEMA_VERSION));
      await t.run(upsert, 'setup_done', '1');
      if (isPg) {
        for (const table of SERIAL_TABLES) await t.get(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
      }
    });

    // Swap the uploads directory contents.
    for (const f of await fsp.readdir(UPLOAD_DIR)) await fsp.rm(path.join(UPLOAD_DIR, f), { force: true, recursive: true });
    for (const f of await fsp.readdir(newUploads)) await fsp.rename(path.join(newUploads, f), path.join(UPLOAD_DIR, f));
    resetBrandingCache();
    return { restoredAt: now(), manifest };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

export const endMaintenance = () => { maintenance = false; };
