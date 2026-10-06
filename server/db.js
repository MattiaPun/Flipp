// Thin async DB adapter: embedded SQLite (WAL) by default, PostgreSQL when DATABASE_URL=postgres://...
// All SQL in the app is written portably with `?` placeholders.
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.DATABASE_URL || '';
export const isPg = /^postgres(ql)?:/.test(url);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? +v : v));

export let db;
if (isPg) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, Number); // BIGINT -> number (ms timestamps fit easily)
  const pool = new pg.Pool({ connectionString: url });
  const q = (sql, p) => { let i = 0; return pool.query(sql.replace(/\?/g, () => '$' + ++i), clean(p)); };
  db = {
    all: async (sql, ...p) => (await q(sql, p)).rows,
    get: async (sql, ...p) => (await q(sql, p)).rows[0],
    run: async (sql, ...p) => ({ changes: (await q(sql, p)).rowCount }),
    exec: (sql) => pool.query(sql),
  };
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const file = url.replace(/^(sqlite|file):(\/\/)?/, '') || path.join(DATA_DIR, 'Flipp.db');
  const s = new DatabaseSync(file);
  s.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const cache = new Map();
  const st = (sql) => cache.get(sql) ?? cache.set(sql, s.prepare(sql)).get(sql);
  db = {
    all: async (sql, ...p) => st(sql).all(...clean(p)),
    get: async (sql, ...p) => st(sql).get(...clean(p)),
    run: async (sql, ...p) => ({ changes: Number(st(sql).run(...clean(p)).changes) }),
    exec: async (sql) => s.exec(sql),
  };
}

const ID = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

// Append-only migrations. Never edit a shipped entry; add a new one.
const migrations = [
  `CREATE TABLE users (id ${ID}, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', password_hash TEXT,
     role TEXT NOT NULL DEFAULT 'user', oidc_sub TEXT UNIQUE, created_at BIGINT NOT NULL);
   CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL);
   CREATE TABLE invites (code TEXT PRIMARY KEY, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     used_by INTEGER REFERENCES users(id) ON DELETE SET NULL, expires_at BIGINT NOT NULL);
   CREATE TABLE courses (id ${ID}, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT '',
     visibility TEXT NOT NULL DEFAULT 'private', created_at BIGINT NOT NULL);
   CREATE TABLE sets (id ${ID}, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL);
   CREATE TABLE cards (id ${ID}, set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE, front TEXT NOT NULL, back TEXT NOT NULL,
     image TEXT, position INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
   CREATE TABLE progress (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     stability DOUBLE PRECISION NOT NULL DEFAULT 0, difficulty DOUBLE PRECISION NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
     reps INTEGER NOT NULL DEFAULT 0, last_reviewed BIGINT, next_due BIGINT, starred INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, card_id));
   CREATE TABLE reviews (id ${ID}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     rating INTEGER NOT NULL, prev TEXT, ts BIGINT NOT NULL);
   CREATE TABLE match_scores (id ${ID}, set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     ms INTEGER NOT NULL, created_at BIGINT NOT NULL);
   CREATE INDEX courses_owner ON courses(owner_id);
   CREATE INDEX sets_course ON sets(course_id);
   CREATE INDEX cards_set ON cards(set_id, position);
   CREATE INDEX reviews_user_ts ON reviews(user_id, ts);
   CREATE INDEX match_set ON match_scores(set_id, ms);`,
];

await db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const version = Number((await db.get("SELECT value FROM settings WHERE key = 'schema_version'"))?.value || 0);
for (let v = version; v < migrations.length; v++) {
  await db.exec(migrations[v]);
  await db.run("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(v + 1));
}

export const getSetting = async (key) => (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value;
export const setSetting = (key, value) =>
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
