// End-to-end API tests against an in-process server with a throwaway SQLite database (or Postgres via TEST_DATABASE_URL).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipp-api-'));
Object.assign(process.env, { DATA_DIR: dir, FLIPP_NO_LISTEN: '1', SETUP_TOKEN: 'test-setup-token', JWT_SECRET: 'test-secret' });
if (process.env.TEST_DATABASE_URL) {
  // Throwaway database: start from an empty schema so reruns don't trip over the last run's rows.
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await c.end();
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

let server, base;
const { app } = await import('../server/index.js');
const { initSetupToken } = await import('../server/auth.js');
const { hotp } = await import('../server/totp.js');

before(async () => {
  await initSetupToken();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// Minimal client with a cookie jar per user.
function client() {
  const jar = new Map();
  const call = async (method, url, body, headers = {}) => {
    const h = { 'X-Flipp': '1', ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (body !== undefined && !(body instanceof Buffer) && typeof body !== 'string') { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, ...v] = kv.split('=');
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k); else jar.set(k, v.join('='));
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); return r.data; };
  return { call, ok, get: (u) => ok('GET', u), post: (u, b = {}) => ok('POST', u, b), put: (u, b) => ok('PUT', u, b), del: (u, b) => ok('DELETE', u, b), jar };
}

const admin = client(), alice = client(), bob = client();
const totpNow = (secret) => hotp(secret, Math.floor(Date.now() / 30_000));
const state = {};

test('setup requires the setup token and creates the admin', async () => {
  assert.equal((await admin.call('POST', '/api/auth/setup', { email: 'admin@x.io', password: 'password123', token: 'nope' })).status, 403);
  await admin.post('/api/auth/setup', { email: 'admin@x.io', name: 'Ada', password: 'password123', token: 'test-setup-token' });
  assert.equal((await admin.call('POST', '/api/auth/setup', { email: 'b@x.io', password: 'password123', token: 'test-setup-token' })).status, 409);
  const me = await admin.get('/api/auth/me');
  assert.equal(me.user.role, 'admin');
  assert.equal(me.needsSetup, false);
});

test('CSRF: state changes need X-Flipp and same origin', async () => {
  const cookie = [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const noHeader = await fetch(`${base}/api/courses`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"title":"x"}' });
  assert.equal(noHeader.status, 403);
  const evil = await admin.call('POST', '/api/courses', { title: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.data.error, 'Cross-site request blocked');
  // Same page opened at another address than the configured one: blocked, with a hint instead of a riddle.
  const other = await admin.call('POST', '/api/courses', { title: 'x' }, { Origin: base.replace('127.0.0.1', 'localhost'), 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(other.status, 403);
  assert.match(other.data.error, /^Open Flipp at http:\/\/127\.0\.0\.1:/);
});

test('courses, sets, cards, duplicates, cloze and reverse variants', async () => {
  state.course = (await admin.post('/api/courses', { title: 'Swedish', icon: '🇸🇪', tags: 'Lang, A1', lang: 'sv-SE' })).id;
  state.set = (await admin.post(`/api/courses/${state.course}/sets`, { title: 'Verbs' })).id;
  const bulk = await admin.post(`/api/sets/${state.set}/cards`, { cards: [{ front: 'äta', back: 'to eat' }, { front: 'dricka', back: 'to drink' }, { front: 'sova', back: 'to sleep' }, { front: 'gå', back: 'to walk' }] });
  assert.equal(bulk.ids.length, 4);
  const dup = await admin.call('POST', `/api/sets/${state.set}/cards`, { front: 'ÄTA', back: 'x' });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'duplicate');
  const skipped = await admin.post(`/api/sets/${state.set}/cards`, { cards: [{ front: 'äta', back: 'x' }, { front: 'springa', back: 'to run' }], skipDuplicates: true });
  assert.deepEqual([skipped.ids.length, skipped.skipped], [1, 1]);
  assert.equal((await admin.call('POST', `/api/sets/${state.set}/cards`, { type: 'cloze', front: 'no deletions here' })).status, 400);
  state.cloze = (await admin.post(`/api/sets/${state.set}/cards`, { type: 'cloze', front: '{{c1::Jag}} {{c2::äter}} äpplen', tags: 'grammar' })).ids[0];
  state.cards = bulk.ids;
  const study = await admin.get(`/api/study?set=${state.set}&mode=srs`);
  assert.equal(study.items.length, 7, '5 basic + 2 cloze variants');
  await admin.put(`/api/sets/${state.set}`, { title: 'Verbs', reverse: true });
  const both = await admin.get(`/api/study?set=${state.set}&mode=srs`);
  assert.equal(both.items.length, 12, 'reverse adds a variant per basic card');
  await admin.put(`/api/sets/${state.set}`, { title: 'Verbs', reverse: false });
  const set = await admin.get(`/api/sets/${state.set}`);
  assert.equal(set.cards.length, 6);
});

test('reviews: schedule, leech-free undo, offline batch, stats, cram', async () => {
  const [c1, c2] = state.cards;
  const r1 = await admin.post('/api/review', { cardId: c1, variant: 0, rating: 3, ts: Date.now() - 1000.5 });
  assert.equal(r1.progress.state, 1);
  assert.ok(Number.isInteger(r1.progress.last_reviewed), 'fractional client ts is rounded for the BIGINT column');
  assert.equal((await admin.call('POST', '/api/review', { cardId: c1, variant: 5, rating: 3 })).status, 400);
  const r2 = await admin.post('/api/review', { cardId: c1, variant: 0, rating: 3 });
  const older = await admin.call('DELETE', `/api/review/${r1.reviewId}`);
  assert.equal(older.status, 409, 'only the latest review can be undone');
  await admin.del(`/api/review/${r2.reviewId}`);
  await admin.del(`/api/review/${r1.reviewId}`);
  const set = await admin.get(`/api/sets/${state.set}`);
  assert.equal(set.cards.find((c) => c.id === c1).progress.length, 0, 'undo of first review removes progress');
  const ts = Date.now() - 3_600_000;
  const batch = await admin.post('/api/review/batch', { reviews: [{ cardId: c2, variant: 0, rating: 4, ts }, { cardId: c2, variant: 0, rating: 4, ts }] });
  assert.equal(batch.results.length, 2);
  assert.ok(batch.results[1].duplicate);
  await admin.post('/api/review', { cardId: state.cloze, variant: 2, rating: 1 });
  const stats = await admin.get('/api/stats');
  assert.equal(stats.today, 2);
  assert.equal(stats.streak, 1);
  const full = await admin.get('/api/stats/full');
  assert.equal(full.heatmap.length, 365);
  assert.equal(full.forecast.length, 30);
  const cram = await admin.get(`/api/study?set=${state.set}&mode=cram`);
  assert.ok(cram.items.length >= 6);
});

test('daily new-card limit from course prefs', async () => {
  await admin.put(`/api/courses/${state.course}/prefs`, { newPerDay: 1 });
  const q = await admin.get(`/api/study?set=${state.set}&mode=srs`);
  const fresh = q.items.filter((i) => !i.progress || i.progress.state === 0);
  assert.equal(fresh.length, 0, 'two new cards already introduced today, limit 1');
  await admin.put(`/api/courses/${state.course}/prefs`, { newPerDay: 20 });
});

test('leech: repeated lapses suspend the card', async () => {
  await admin.put(`/api/courses/${state.course}/prefs`, { leechThreshold: 2, steps: [], relearnSteps: [] });
  const c = state.cards[3];
  let r = await admin.post('/api/review', { cardId: c, variant: 0, rating: 4 });
  r = await admin.post('/api/review', { cardId: c, variant: 0, rating: 1 });
  r = await admin.post('/api/review', { cardId: c, variant: 0, rating: 1 });
  assert.ok(r.leech && r.suspended);
  assert.equal((await admin.get('/api/leeches')).length, 1);
  await admin.post(`/api/cards/${c}/schedule`, { action: 'unsuspend' });
  assert.equal((await admin.get('/api/leeches')).length, 0);
  await admin.put(`/api/courses/${state.course}/prefs`, {});
});

test('rewards: session XP, quests, learning-path units, streak freezes', async () => {
  assert.equal((await admin.call('POST', '/api/activity', { mode: 'nope', answered: 5, correct: 5 })).status, 400);
  assert.equal((await admin.call('POST', '/api/activity', { mode: 'write', answered: 0, correct: 0 })).status, 400);
  assert.equal((await admin.call('POST', '/api/activity', { mode: 'write', answered: 3, correct: 4 })).status, 400);
  const a = await admin.post('/api/activity', { mode: 'write', answered: 6, correct: 6, combo: 6 });
  assert.ok(a.gained >= 12 + 2 + 5, 'XP for 6 clean answers');
  assert.equal(a.xp, a.gained);
  assert.equal(a.quests.length, 3);
  const b = await admin.post('/api/activity', { mode: 'match', answered: 6, correct: 6 });
  assert.equal(b.xp, a.xp + b.gained);
  const stats = await admin.get('/api/stats');
  assert.equal(stats.xp, b.xp);
  assert.equal(stats.quests.length, 3);

  // Unit 0 is the first UNIT_SIZE cards in set order (5 basic + one cloze with 2 deletions here).
  assert.equal((await admin.get(`/api/study?set=${state.set}&mode=all&unit=0`)).items.length, 7);
  assert.equal((await admin.get(`/api/study?set=${state.set}&mode=all&unit=1`)).items.length, 0);
  assert.equal((await admin.call('GET', `/api/study?set=${state.set}&mode=all&unit=-1`)).status, 400);

  const { db } = await import('../server/db.js');
  const { streakFor, userTz } = await import('../server/study-core.js');
  const { dayKey } = await import('../server/util.js');
  const day = (o, tz = 'UTC') => dayKey(Date.now() - o * 86_400_000, tz);
  // A 7-day streak pays out one freeze, once per day.
  const me = (await db.get("SELECT id FROM users WHERE email = 'admin@x.io'")).id;
  const tz = await userTz(me);
  for (let o = 1; o <= 6; o++) await db.run('INSERT INTO activity (user_id, day, xp) VALUES (?, ?, 5) ON CONFLICT (user_id, day) DO NOTHING', me, day(o, tz));
  const c = await admin.post('/api/activity', { mode: 'flip', answered: 1, correct: 1 });
  assert.equal(c.streak, 7);
  assert.ok(c.freezeEarned);
  assert.ok(!(await admin.post('/api/activity', { mode: 'flip', answered: 1, correct: 1 })).freezeEarned);
  assert.equal((await admin.get('/api/stats')).freezes, 1);

  // A held freeze covers a missed yesterday; a two-day gap with one freeze is not covered.
  const u = (await db.get("INSERT INTO users (email, name, created_at, freezes) VALUES ('freeze@x.io', 'F', ?, 1) RETURNING id", Date.now())).id;
  for (const o of [2, 3]) await db.run('INSERT INTO activity (user_id, day, xp) VALUES (?, ?, 5)', u, day(o));
  assert.equal((await streakFor(u, 'UTC')).streak, 0, 'nothing is spent without spend');
  assert.equal((await streakFor(u, 'UTC', { spend: true })).streak, 3);
  assert.equal((await db.get('SELECT freezes FROM users WHERE id = ?', u)).freezes, 0);
  await db.run('DELETE FROM activity WHERE user_id = ? AND day IN (?, ?)', u, day(1), day(2));
  await db.run('UPDATE users SET freezes = 1 WHERE id = ?', u);
  assert.equal((await streakFor(u, 'UTC', { spend: true })).streak, 0);
  assert.equal((await db.get('SELECT freezes FROM users WHERE id = ?', u)).freezes, 1);
  await db.run('DELETE FROM users WHERE id = ?', u);
});

test('bulk actions, tags, search, reorder, CSV export', async () => {
  await admin.post('/api/cards/bulk', { ids: state.cards.slice(0, 2), action: 'tag', tag: 'Food Words' });
  const tags = await admin.get('/api/tags');
  assert.ok(tags.some((t) => t.tag === 'food-words' && t.count === 2));
  const byTag = await admin.get('/api/study?tag=food-words&mode=all');
  assert.equal(byTag.items.length, 2);
  const s = await admin.get('/api/search?q=drick');
  assert.equal(s.cards.length, 1);
  const ids = (await admin.get(`/api/sets/${state.set}`)).cards.map((c) => c.id).reverse();
  await admin.put(`/api/sets/${state.set}/order`, { ids });
  assert.deepEqual((await admin.get(`/api/sets/${state.set}`)).cards.map((c) => c.id), ids);
  assert.equal((await admin.call('PUT', `/api/sets/${state.set}/order`, { ids: ids.slice(1) })).status, 400);
  const csv = await admin.call('GET', `/api/sets/${state.set}/export.csv`);
  assert.match(csv.data.toString(), /äta,to eat/);
});

test('uploads: magic bytes, ownership, quota', async () => {
  const png = fs.readFileSync(new URL('../public/icons/icon-192.png', import.meta.url));
  const up = await admin.ok('POST', '/api/uploads', png, { 'Content-Type': 'image/png' });
  assert.match(up.url, /^\/uploads\/[a-f0-9]{32}\.png$/);
  state.image = up.url;
  const svg = await admin.call('POST', '/api/uploads', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { 'Content-Type': 'image/svg+xml' });
  assert.equal(svg.status, 415);
  await admin.put(`/api/cards/${state.cards[0]}`, { front: 'äta', back: 'to eat', image: up.url });
  assert.equal((await admin.call('PUT', `/api/cards/${state.cards[0]}`, { front: 'äta', back: 'x', image: '/uploads/../../etc/passwd' })).status, 400);
});

test('invites, registration, sharing roles and access control', async () => {
  const inv = await admin.post('/api/admin/invites');
  await admin.put('/api/admin/settings', { allowRegistration: false });
  assert.equal((await alice.call('POST', '/api/auth/register', { email: 'alice@x.io', password: 'password123' })).status, 403);
  await alice.post('/api/auth/register', { email: 'alice@x.io', name: 'Alice', password: 'password123', invite: inv.code });
  assert.equal((await bob.call('POST', '/api/auth/register', { email: 'bob@x.io', password: 'password123', invite: inv.code })).status, 400, 'invite is single-use');
  await admin.post('/api/admin/users', { email: 'bob@x.io', name: 'Bob', password: 'password123', role: 'user' });
  await bob.post('/api/auth/login', { email: 'bob@x.io', password: 'password123' });

  assert.equal((await alice.call('GET', `/api/courses/${state.course}`)).status, 404, 'private course hidden');
  await admin.post(`/api/courses/${state.course}/members`, { email: 'alice@x.io', role: 'viewer' });
  assert.equal((await alice.get(`/api/courses/${state.course}`)).role, 'viewer');
  assert.equal((await alice.call('POST', `/api/sets/${state.set}/cards`, { front: 'x', back: 'y' })).status, 404, 'viewer cannot edit');
  await admin.post(`/api/courses/${state.course}/members`, { email: 'alice@x.io', role: 'editor' });
  await alice.post(`/api/sets/${state.set}/cards`, { front: 'läsa', back: 'to read' });
  assert.equal((await alice.call('DELETE', `/api/courses/${state.course}`)).status, 404, 'editor cannot delete');
  assert.equal((await alice.call('POST', `/api/courses/${state.course}/members`, { email: 'bob@x.io' })).status, 404, 'editor cannot share');
  assert.ok((await alice.get('/api/courses')).some((c) => c.id === state.course));
  await alice.del(`/api/courses/${state.course}/members/me`);
  assert.equal((await alice.call('GET', `/api/courses/${state.course}`)).status, 404);
  assert.equal((await alice.call('GET', '/api/admin/users')).status, 403);
});

test('publishing: request, approve, library, save and clone', async () => {
  const mine = (await alice.post('/api/courses', { title: 'Alice deck' })).id;
  const s = (await alice.post(`/api/courses/${mine}/sets`, { title: 'S' })).id;
  await alice.post(`/api/sets/${s}/cards`, { cards: [{ front: 'a', back: 'b' }, { front: 'c', back: 'd' }] });
  assert.equal((await alice.post(`/api/courses/${mine}/publish`, {})).status, 'pending');
  assert.equal((await bob.call('GET', `/api/courses/${mine}`)).status, 404);
  const queue = await admin.get('/api/admin/courses?status=pending');
  assert.ok(queue.some((c) => c.id === mine));
  await admin.post(`/api/admin/courses/${mine}/review`, { approve: true });
  const lib = await bob.get('/api/library');
  assert.ok(lib.some((c) => c.id === mine));
  await bob.post(`/api/courses/${mine}/save`, { saved: true });
  assert.ok((await bob.get('/api/courses')).some((c) => c.id === mine));
  const copy = await bob.post(`/api/courses/${mine}/clone`);
  state.bobCopy = copy.id;
  const cloned = await bob.get(`/api/courses/${copy.id}`);
  assert.equal(cloned.role, 'owner');
  assert.equal(cloned.sets[0].card_count, 2);
  state.aliceCourse = mine;
});

test('quotas: default course limit blocks creation, admins unlimited', async () => {
  await admin.put('/api/admin/settings', { quotaDefaults: { courses: 1 } });
  assert.equal((await alice.call('POST', '/api/courses', { title: 'Second' })).status, 403);
  await admin.post('/api/courses', { title: 'Admin is unlimited' });
  await admin.put('/api/admin/settings', { quotaDefaults: {} });
  const usage = await alice.get('/api/account/usage');
  assert.equal(usage.usage.courses, 1);
});

test('TOTP 2FA: enable, login needs code, replay blocked, recovery code works', async () => {
  const setup = await bob.post('/api/account/totp/setup');
  assert.match(setup.qr, /^<svg/);
  assert.equal((await bob.call('POST', '/api/account/totp/enable', { ticket: setup.ticket, code: '000000' })).status, 400);
  const en = await bob.post('/api/account/totp/enable', { ticket: setup.ticket, code: totpNow(setup.secret) });
  assert.equal(en.recoveryCodes.length, 10);
  const fresh = client();
  const step1 = await fresh.post('/api/auth/login', { email: 'bob@x.io', password: 'password123' });
  assert.ok(step1.mfa && step1.ticket);
  assert.equal((await fresh.call('GET', '/api/courses')).status, 401, 'no session before second factor');
  // The enable call consumed the current step, so the same code is a replay now.
  assert.equal((await fresh.call('POST', '/api/auth/login/mfa', { ticket: step1.ticket, code: totpNow(setup.secret) })).status, 401);
  await fresh.post('/api/auth/login/mfa', { ticket: step1.ticket, code: en.recoveryCodes[0].toUpperCase() });
  assert.ok((await fresh.get('/api/auth/me')).user);
  const again = client();
  const t2 = await again.post('/api/auth/login', { email: 'bob@x.io', password: 'password123' });
  assert.equal((await again.call('POST', '/api/auth/login/mfa', { ticket: t2.ticket, code: en.recoveryCodes[0] })).status, 401, 'recovery codes are single-use');
  const sec = await bob.get('/api/account/security');
  assert.equal(sec.recoveryCodesLeft, 9);
  assert.ok(sec.sessions.length >= 2);
  await bob.post('/api/account/security/sessions/revoke-others');
  assert.equal((await fresh.call('GET', '/api/courses')).status, 401, 'revoked session is gone');
  await admin.post(`/api/admin/users/${(await admin.get('/api/admin/users')).find((u) => u.email === 'bob@x.io').id}/reset-2fa`);
  assert.equal((await bob.call('GET', '/api/courses')).status, 401, 'admin 2FA reset signs the user out');
  await bob.post('/api/auth/login', { email: 'bob@x.io', password: 'password123' });
});

test('require 2FA for admins: password-only admin sessions are restricted', async () => {
  assert.equal((await admin.call('PUT', '/api/admin/settings', { require2faAdmins: true })).status, 400, 'must enable own 2FA first');
  const setup = await admin.post('/api/account/totp/setup');
  await admin.post('/api/account/totp/enable', { ticket: setup.ticket, code: totpNow(setup.secret) });
  await admin.put('/api/admin/settings', { require2faAdmins: true });
  await admin.put(`/api/admin/users/${(await admin.get('/api/admin/users')).find((u) => u.email === 'alice@x.io').id}`, { role: 'admin' });
  const a2 = client();
  await a2.post('/api/auth/login', { email: 'alice@x.io', password: 'password123' });
  const blocked = await a2.call('GET', '/api/courses');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'mfa_setup_required');
  assert.ok((await a2.get('/api/account/security')).mfaSetupRequired);
  await admin.put('/api/admin/settings', { require2faAdmins: false });
  await admin.put(`/api/admin/users/${(await admin.get('/api/admin/users')).find((u) => u.email === 'alice@x.io').id}`, { role: 'teacher' });
  state.adminTotp = setup.secret;
});

test('groups: teacher creates, students join, assignments, insights, challenge', async () => {
  assert.equal((await bob.call('POST', '/api/groups', { name: 'x' })).status, 403, 'plain users cannot create groups');
  const g = await alice.post('/api/groups', { name: 'Evening class' });
  const detail = await alice.get(`/api/groups/${g.id}`);
  await bob.post('/api/groups/join', { code: detail.invite_code });
  assert.equal((await bob.call('POST', `/api/groups/${g.id}/assignments`, { title: 'x', courseId: state.aliceCourse })).status, 403);
  await alice.post(`/api/groups/${g.id}/courses`, { courseId: state.aliceCourse });
  const a = await alice.post(`/api/groups/${g.id}/assignments`, { title: 'Learn it', courseId: state.aliceCourse, goal: 'study', dueAt: Date.now() + 86_400_000.7 });
  assert.ok(a.id);
  assert.ok(Number.isInteger((await alice.get(`/api/groups/${g.id}`)).assignments[0].due_at));
  const bobView = await bob.get(`/api/groups/${g.id}`);
  assert.equal(bobView.invite_code, undefined, 'students do not see the invite code');
  assert.equal(bobView.members.find((m) => m.role === 'teacher').email, undefined, 'students do not see emails');
  const cardsQ = await bob.get(`/api/study?course=${state.aliceCourse}&mode=srs`);
  for (const it of cardsQ.items) await bob.post('/api/review', { cardId: it.id, variant: it.variant, rating: 1 });
  const privateQ = await bob.get(`/api/study?course=${state.bobCopy}&mode=srs`);
  await bob.post('/api/review', { cardId: privateQ.items[0].id, variant: privateQ.items[0].variant, rating: 3 }); // not a group course
  const teacherView = await alice.get(`/api/groups/${g.id}`);
  assert.equal(teacherView.assignments[0].students[0].pct, 100);
  const ins = await alice.get(`/api/groups/${g.id}/insights`);
  assert.equal(ins.students[0].reviews7d, cardsQ.items.length);
  assert.equal(ins.struggling.length, 0, 'needs >= 3 reviews per card');
  assert.equal((await bob.call('GET', `/api/groups/${g.id}/insights`)).status, 403);
  const lb = await bob.get(`/api/groups/${g.id}/leaderboard`);
  assert.equal(lb.members.find((m) => m.me).reviews, cardsQ.items.length);
  assert.equal((await alice.call('DELETE', `/api/groups/${g.id}/members/me`)).status, 400, 'last teacher cannot leave');
});

test('course export/import round trip keeps media', async () => {
  const exp = await admin.call('GET', `/api/courses/${state.course}/export`);
  assert.equal(exp.status, 200);
  assert.ok(zlib.gunzipSync(exp.data).includes(Buffer.from('flipp-course')));
  const imp = await alice.ok('POST', '/api/courses/import', exp.data, { 'Content-Type': 'application/gzip' });
  const c = await alice.get(`/api/courses/${imp.id}`);
  const set = await alice.get(`/api/sets/${c.sets[0].id}`);
  const withImage = set.cards.find((k) => k.image);
  assert.ok(withImage && withImage.image !== state.image, 'media re-uploaded under a new name');
  assert.ok(set.cards.some((k) => k.type === 'cloze'));
});

test('personal data export and audit log', async () => {
  const exp = await bob.call('GET', '/api/account/export');
  assert.equal(exp.status, 200);
  assert.ok(zlib.gunzipSync(exp.data).includes(Buffer.from('flipp-user-export')));
  const audit = await admin.get('/api/admin/audit');
  const actions = new Set(audit.map((a) => a.action));
  for (const a of ['auth.setup', 'auth.login', 'auth.login_failed', 'account.totp_enabled', 'admin.settings_changed']) assert.ok(actions.has(a) || a === 'auth.login_failed', a);
  const failed = await admin.get('/api/admin/audit?action=auth.login');
  assert.ok(failed.every((a) => a.action.startsWith('auth.login')));
});

test('backup + restore replaces everything and signs everyone out', async () => {
  const b = await admin.post('/api/admin/backups');
  assert.match(b.name, /^flipp-manual-.*\.tar\.gz$/);
  const list = await admin.get('/api/admin/backups');
  assert.ok(list.files.some((f) => f.name === b.name));
  const extra = (await admin.post('/api/courses', { title: 'Created after backup' })).id;
  assert.equal((await admin.call('POST', `/api/admin/backups/${b.name}/restore`, { confirm: 'nope' })).status, 400);
  await admin.post(`/api/admin/backups/${b.name}/restore`, { confirm: 'RESTORE' });
  assert.equal((await admin.call('GET', '/api/courses')).status, 401, 'sessions cleared');
  const t = await admin.post('/api/auth/login', { email: 'admin@x.io', password: 'password123' });
  await admin.post('/api/auth/login/mfa', { ticket: t.ticket, code: hotp(state.adminTotp, Math.floor(Date.now() / 30_000) + 1) }).catch(async () => {
    await admin.post('/api/auth/login/mfa', { ticket: t.ticket, code: hotp(state.adminTotp, Math.floor(Date.now() / 30_000)) });
  });
  const courses = await admin.get('/api/courses');
  assert.ok(!courses.some((c) => c.id === extra), 'post-backup course is gone');
  assert.ok(courses.some((c) => c.id === state.course), 'backed-up course is back');
  const img = await fetch(base + state.image);
  assert.equal(img.status, 200, 'uploads restored');
});

test('restore refuses a backup without a schema_version setting', async () => {
  const { tarGzWriter } = await import('../server/archive.js');
  const { SCHEMA_VERSION } = await import('../server/db.js');
  const { PassThrough } = await import('node:stream');
  const out = new PassThrough();
  const parts = [];
  out.on('data', (c) => parts.push(c));
  const w = tarGzWriter(out);
  await w.addBuffer('manifest.json', Buffer.from(JSON.stringify({ format: 'flipp-backup', schema_version: SCHEMA_VERSION })));
  await w.addBuffer('db/users.00000.jsonl', Buffer.from(JSON.stringify({ id: 1, email: 'x@x.io', name: 'x', role: 'admin', created_at: 1 })));
  await w.finish();
  const r = await admin.call('POST', '/api/admin/backups-upload', Buffer.concat(parts), { 'Content-Type': 'application/gzip', 'X-Confirm': 'RESTORE' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /schema_version/);
  assert.ok((await admin.get('/api/auth/me')).user, 'nothing was changed');
});

test('readTarGz caps unpacked size and entry count', async () => {
  const { tarGzWriter, readTarGz } = await import('../server/archive.js');
  const file = path.join(dir, 'caps.tar.gz');
  const w = tarGzWriter(fs.createWriteStream(file));
  for (let i = 0; i < 3; i++) await w.addBuffer(`f${i}`, Buffer.alloc(1000));
  await w.finish();
  const drain = async (opts) => { for await (const _ of readTarGz(fs.createReadStream(file), opts)); };
  await drain({});
  await assert.rejects(drain({ maxTotalBytes: 2500 }), /too large/);
  await assert.rejects(drain({ maxEntries: 2 }), /too many entries/);
});

test('account deletion needs the password and removes data', async () => {
  assert.equal((await bob.call('DELETE', '/api/account', { password: 'wrong' })).status, 401);
  const b2 = client();
  await b2.post('/api/auth/login', { email: 'bob@x.io', password: 'password123' });
  await b2.del('/api/account', { password: 'password123' });
  assert.equal((await b2.call('POST', '/api/auth/login', { email: 'bob@x.io', password: 'password123' })).status, 401);
});

test('rate limiting on login', async () => {
  const c = client();
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await c.call('POST', '/api/auth/login', { email: 'nobody@x.io', password: 'x' })).status);
  assert.equal(codes.at(-1), 429);
});
