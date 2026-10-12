// Thin async DB adapter: embedded SQLite (WAL) by default, PostgreSQL when DATABASE_URL=postgres://...
// All SQL in the app is written portably with `?` placeholders.
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.DATABASE_URL || '';
export const isPg = /^postgres(ql)?:/.test(url);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? +v : v));

// Each adapter exposes all/get/run/exec plus tx(fn): fn receives a db-like object bound to one transaction.
export let db;
if (isPg) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, Number); // BIGINT -> number (ms timestamps fit easily)
  const pool = new pg.Pool({ connectionString: url });
  const bind = (runner) => {
    const q = (sql, p) => { let i = 0; return runner.query(sql.replace(/\?/g, () => '$' + ++i), clean(p)); };
    return {
      all: async (sql, ...p) => (await q(sql, p)).rows,
      get: async (sql, ...p) => (await q(sql, p)).rows[0],
      run: async (sql, ...p) => ({ changes: (await q(sql, p)).rowCount }),
      exec: (sql) => runner.query(sql),
    };
  };
  db = {
    ...bind(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(bind(client));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
} else {
  const { DatabaseSync } = await import('node:sqlite');
  const file = url.replace(/^(sqlite|file):(\/\/)?/, '') || path.join(DATA_DIR, 'Flipp.db');
  const s = new DatabaseSync(file);
  s.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const cache = new Map();
  const st = (sql) => cache.get(sql) ?? cache.set(sql, s.prepare(sql)).get(sql);
  const base = {
    all: async (sql, ...p) => st(sql).all(...clean(p)),
    get: async (sql, ...p) => st(sql).get(...clean(p)),
    run: async (sql, ...p) => ({ changes: Number(st(sql).run(...clean(p)).changes) }),
    exec: async (sql) => s.exec(sql),
  };
  // One connection, so transactions are serialized through a promise chain.
  // ponytail: queries from other requests can interleave if fn awaits non-DB I/O; keep tx bodies DB-only.
  let chain = Promise.resolve();
  db = {
    ...base,
    tx(fn) {
      const run = chain.then(async () => {
        s.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(base);
          s.exec('COMMIT');
          return result;
        } catch (e) {
          if (s.isTransaction) s.exec('ROLLBACK');
          throw e;
        }
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}

const ID = isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';

// Append-only migrations. Never edit a shipped entry; add a new one.
const migrations = [
  // variant: 0 = front->back, 1 = back->front (reverse), n >= 1 = cloze number for cloze cards.
  // state: 0 new, 1 learning, 2 review, 3 relearning.
  // streak_days: days a streak freeze covered (frozen) and days whose 7-day milestone paid out a freeze (freeze_earned).
  `CREATE TABLE users (id ${ID}, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', password_hash TEXT,
     role TEXT NOT NULL DEFAULT 'user', oidc_sub TEXT UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, totp_secret TEXT, totp_last_step BIGINT,
     fsrs_params TEXT, prefs TEXT NOT NULL DEFAULT '{}', freezes INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
   CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, last_seen BIGINT NOT NULL, ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
     method TEXT NOT NULL DEFAULT 'password');
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE invites (code TEXT PRIMARY KEY, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     used_by INTEGER REFERENCES users(id) ON DELETE SET NULL, expires_at BIGINT NOT NULL);

   CREATE TABLE courses (id ${ID}, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '', icon TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT '',
     visibility TEXT NOT NULL DEFAULT 'private', cloned_from INTEGER, created_at BIGINT NOT NULL);
   CREATE INDEX courses_owner ON courses(owner_id);
   CREATE TABLE sets (id ${ID}, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '', reverse INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
   CREATE INDEX sets_course ON sets(course_id);
   CREATE TABLE cards (id ${ID}, set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE, type TEXT NOT NULL DEFAULT 'basic',
     front TEXT NOT NULL, back TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', mnemonic TEXT NOT NULL DEFAULT '', example TEXT NOT NULL DEFAULT '',
     image TEXT, audio TEXT, tags TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT);
   CREATE INDEX cards_set ON cards(set_id, position);

   CREATE TABLE progress (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     variant INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0, step INTEGER NOT NULL DEFAULT 0,
     stability DOUBLE PRECISION NOT NULL DEFAULT 0, difficulty DOUBLE PRECISION NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
     reps INTEGER NOT NULL DEFAULT 0, last_reviewed BIGINT, next_due BIGINT, suspended INTEGER NOT NULL DEFAULT 0, leech INTEGER NOT NULL DEFAULT 0,
     buried_until BIGINT, PRIMARY KEY (user_id, card_id, variant));
   CREATE INDEX progress_due ON progress(user_id, next_due);
   CREATE INDEX progress_card ON progress(card_id);
   CREATE TABLE stars (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     PRIMARY KEY (user_id, card_id));
   CREATE TABLE reviews (id ${ID}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     variant INTEGER NOT NULL DEFAULT 0, rating INTEGER NOT NULL, prev TEXT, ts BIGINT NOT NULL, was_new INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 2);
   CREATE INDEX reviews_user_ts ON reviews(user_id, ts);
   CREATE INDEX reviews_card ON reviews(card_id);
   CREATE TABLE streak_days (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
     frozen INTEGER NOT NULL DEFAULT 0, freeze_earned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));

   CREATE TABLE course_prefs (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
     prefs TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (user_id, course_id));
   CREATE TABLE saved_courses (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
     created_at BIGINT NOT NULL, PRIMARY KEY (user_id, course_id));
   CREATE TABLE course_members (course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     role TEXT NOT NULL DEFAULT 'viewer', created_at BIGINT NOT NULL, PRIMARY KEY (course_id, user_id));
   CREATE INDEX course_members_user ON course_members(user_id);

   CREATE TABLE recovery_codes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, used_at BIGINT,
     PRIMARY KEY (user_id, code_hash));
   CREATE TABLE passkeys (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key TEXT NOT NULL,
     counter BIGINT NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, last_used BIGINT);
   CREATE INDEX passkeys_user ON passkeys(user_id);
   CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires_at BIGINT NOT NULL);
   CREATE TABLE audit_log (id ${ID}, ts BIGINT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, actor TEXT NOT NULL DEFAULT '',
     ip TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '');
   CREATE INDEX audit_ts ON audit_log(ts);
   CREATE INDEX audit_action ON audit_log(action, ts);
   CREATE TABLE uploads (name TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, size BIGINT NOT NULL, kind TEXT NOT NULL,
     created_at BIGINT NOT NULL);
   CREATE INDEX uploads_user ON uploads(user_id);
   CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at BIGINT NOT NULL);`,
];

// Tables in foreign-key order (parents first). Used by backup/restore and data export.
export const TABLES = [
  'settings', 'users', 'invites', 'courses', 'sets', 'cards', 'progress', 'stars', 'reviews', 'streak_days', 'course_prefs',
  'saved_courses', 'course_members', 'recovery_codes', 'passkeys', 'audit_log', 'uploads', 'push_subscriptions',
];

await db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const version = Number((await db.get("SELECT value FROM settings WHERE key = 'schema_version'"))?.value || 0);
for (let v = version; v < migrations.length; v++) {
  await db.tx(async (t) => {
    await t.exec(migrations[v]);
    await t.run("INSERT INTO settings (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(v + 1));
  });
}
export const SCHEMA_VERSION = migrations.length;

export const getSetting = async (key) => (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value;
export const setSetting = (key, value) =>
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
export const getJsonSetting = async (key, def) => { try { return JSON.parse((await getSetting(key)) ?? 'null') ?? def; } catch { return def; } };
