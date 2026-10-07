// Demo seed (server/seed.js) against a throwaway SQLite database: refuses before setup, seeds every feature,
// is idempotent, and --reset replaces only demo data. SQLite only: api.test.js owns the Postgres schema.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipp-seed-'));
Object.assign(process.env, { DATA_DIR: dir, FLIPP_NO_LISTEN: '1', JWT_SECRET: 'seed-secret' });
delete process.env.DATABASE_URL;
const { app } = await import('../server/index.js');
const { db, UPLOAD_DIR } = await import('../server/db.js');
const { completeSetup, createUser } = await import('../server/auth.js');
const { seed, png } = await import('../server/seed.js');
const { sniff } = await import('../server/storage.js');
const { DUE } = await import('../server/study-core.js');

const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'X-Flipp': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  return async (url) => { const r = await fetch(base + url, { headers: { Cookie: cookie } }); assert.equal(r.status, 200, url); return r.json(); };
}
const n = async (sql, ...p) => Number((await db.get(sql, ...p)).n);

test('generated swatches are valid PNGs', () => {
  assert.deepEqual(sniff(png([255, 0, 0])), { ext: 'png', kind: 'image' });
});

test('refuses before setup', async () => {
  await assert.rejects(seed(), /setup/);
});

test('seeds every feature for the admin, idempotently, and --reset keeps real data', async () => {
  await completeSetup();
  const admin = await createUser({ email: 'admin@x.io', name: 'Admin', pw: 'password123', role: 'admin', verified: true });
  await db.run("INSERT INTO courses (owner_id, title, created_at) VALUES (?, 'Mine', ?)", admin.id, Date.now());

  const r = await seed();
  assert.equal(r.target, 'admin@x.io');
  assert.ok(r.counts.cards > 300 && r.counts.reviews > 1000, JSON.stringify(r.counts));
  assert.deepEqual(await seed(), { skipped: true });

  const t = Date.now();
  const due = `SELECT COUNT(*) AS n FROM progress p JOIN cards k ON k.id = p.card_id JOIN sets s ON s.id = k.set_id WHERE p.user_id = ? AND ${DUE}`;
  assert.ok(await n(due, admin.id, t, t) > 0, 'admin has cards due');
  assert.ok(await n('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND leech = 1 AND suspended = 1', admin.id) >= 1, 'suspended leech');
  assert.ok(await n('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND leech = 1 AND suspended = 0', admin.id) >= 1, 'tagged leech');
  assert.equal(await n('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND buried_until > ?', admin.id, t), 2);
  assert.equal(await n('SELECT COUNT(*) AS n FROM reviews WHERE ts > ?', t), 0, 'no reviews in the future');
  // Progress rows are exactly what replaying the review log produced.
  assert.equal(await n(`SELECT COUNT(*) AS n FROM progress p WHERE p.reps <> (SELECT COUNT(*) FROM reviews r
    WHERE r.user_id = p.user_id AND r.card_id = p.card_id AND r.variant = p.variant)`), 0);
  const uploads = await db.all('SELECT name FROM uploads');
  assert.equal(uploads.length, 11);
  for (const u of uploads) assert.ok(fs.existsSync(path.join(UPLOAD_DIR, u.name)));

  // Through the API, as the admin and the teacher would see it.
  const asAdmin = await login('admin@x.io', 'password123');
  const stats = await asAdmin('/api/stats');
  assert.ok(stats.streak >= 10 && stats.due > 0 && stats.studiedToday, JSON.stringify(stats));
  const library = await asAdmin('/api/library');
  assert.equal(library[0].title, 'Swedish for beginners');
  assert.equal(library[0].featured, 1);
  assert.ok(library.length >= 6);
  const groups = (await asAdmin('/api/groups')).groups;
  assert.deepEqual(groups.map((g) => g.role).sort(), ['member', 'teacher']);
  const club = groups.find((g) => g.role === 'teacher');
  assert.ok((await asAdmin(`/api/groups/${club.id}/insights`)).students.some((s) => s.reviews7d > 0));
  const courses = await asAdmin('/api/courses');
  assert.ok(courses.some((c) => c.member_role === 'editor') && courses.some((c) => c.member_role === 'viewer'));
  const asTeacher = await login('rivera@demo.flipp.test', 'demo1234');
  const cls = (await asTeacher('/api/groups')).groups[0];
  const board = await asTeacher(`/api/groups/${cls.id}/leaderboard`);
  assert.ok(board.members.filter((m) => m.reviews > 0).length >= 3, 'weekly challenge has data');

  const oldFiles = uploads.map((u) => u.name);
  await seed({ reset: true });
  assert.equal(await n('SELECT COUNT(*) AS n FROM courses'), 13);
  assert.equal(await n("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@demo.flipp.test'"), 8);
  assert.equal(await n('SELECT COUNT(*) AS n FROM study_groups'), 2);
  assert.equal(await n("SELECT COUNT(*) AS n FROM courses WHERE title = 'Mine'"), 1, 'real data untouched');
  assert.ok(oldFiles.every((f) => !fs.existsSync(path.join(UPLOAD_DIR, f))), 'old swatches removed');
  assert.equal(fs.readdirSync(UPLOAD_DIR).length, 11);
});
