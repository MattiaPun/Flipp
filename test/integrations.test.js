// Integration tests for the parts that talk to the outside world or run on a timer:
// email (password reset, verification, invites) via a fake SMTP server, Anki .apkg import (legacy + modern
// zstd/protobuf format), scheduled backups, and push subscriptions + the reminder job.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { zipSync } from 'fflate';

// ---------- Fake SMTP server (just enough of RFC 5321 for nodemailer) ----------
const mails = [];
const smtp = net.createServer((sock) => {
  let data = false, buf = '', mail; // per connection: nodemailer may send several mails in parallel
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (data) {
        if (line === '.') { data = false; mail.done = true; sock.write('250 queued\r\n'); } else mail.body += line + '\n';
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 fake\r\n');
      else if (cmd === 'MAIL') { mails.push(mail = { body: '' }); sock.write('250 ok\r\n'); }
      else if (cmd === 'RCPT') { mail.to = line.match(/<(.+)>/)?.[1]; sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipp-int-'));
Object.assign(process.env, {
  DATA_DIR: dir, FLIPP_NO_LISTEN: '1', SETUP_TOKEN: 'tok', JWT_SECRET: 'int-secret', MAX_IMPORT_MB: '5', // unpacked cap 20 MB
  SMTP_URL: `smtp://127.0.0.1:${smtp.address().port}?ignoreTLS=true`, MAIL_FROM: 'Flipp <flipp@example.com>',
});
const { app } = await import('../server/index.js');
const { initSetupToken } = await import('../server/auth.js');
const { tick } = await import('../server/jobs.js');
const { db } = await import('../server/db.js');
const { hotp } = await import('../server/totp.js');

let server, base;
before(async () => { await initSetupToken(); await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  const jar = new Map();
  const call = async (method, url, body, headers = {}) => {
    const h = { 'X-Flipp': '1', ...headers };
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (body !== undefined && !(body instanceof Buffer)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie()) { const [k, ...v] = c.split(';')[0].split('='); jar.set(k, v.join('=')); }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    return { status: res.status, data };
  };
  const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[0]} ${a[1]} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
  return { call, ok };
}
const admin = client();
const waitForMail = async (to) => { for (let i = 0; i < 50; i++) { const m = mails.find((x) => x.to === to && x.done); if (m) return m; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`no mail to ${to}`); };
const qp = (s) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); // quoted-printable
const tokenIn = (mail, route) => qp(mail.body).match(new RegExp(`#/${route}\\?token=([\\w-]+)`))?.[1];

test('setup + email features reported', async () => {
  await admin.ok('POST', '/api/auth/setup', { email: 'admin@x.io', password: 'password123', token: 'tok' });
  assert.equal((await admin.ok('GET', '/api/auth/me')).mail, true);
});

test('password reset by email: same answer for unknown users, token works once, signs out', async () => {
  const anon = client();
  await anon.ok('POST', '/api/auth/forgot', { email: 'nobody@x.io' });
  await anon.ok('POST', '/api/auth/forgot', { email: 'admin@x.io' });
  const mail = await waitForMail('admin@x.io');
  const token = tokenIn(mail, 'reset');
  assert.ok(token, mail.body);
  assert.ok(!mails.some((m) => m.to === 'nobody@x.io'));
  await anon.ok('POST', '/api/auth/reset', { token, password: 'newpassword1' });
  assert.equal((await anon.call('POST', '/api/auth/reset', { token, password: 'again12345' })).status, 400, 'single use');
  assert.equal((await admin.call('GET', '/api/courses')).status, 401, 'existing sessions ended');
  await admin.ok('POST', '/api/auth/login', { email: 'admin@x.io', password: 'newpassword1' });
});

test('email verification gate + invite by email', async () => {
  await admin.ok('PUT', '/api/admin/settings', { requireEmailVerification: true });
  const u = client();
  const r = await u.ok('POST', '/api/auth/register', { email: 'new@x.io', password: 'password123' });
  assert.ok(r.verify);
  const login = await u.call('POST', '/api/auth/login', { email: 'new@x.io', password: 'password123' });
  assert.equal(login.data.code, 'email_unverified');
  const token = tokenIn(await waitForMail('new@x.io'), 'verify');
  await u.ok('POST', '/api/auth/verify', { token });
  assert.equal((await u.ok('GET', '/api/auth/me')).user.email, 'new@x.io');
  const inv = await admin.ok('POST', '/api/admin/invites', { email: 'friend@x.io' });
  assert.ok(inv.emailed);
  assert.match(qp((await waitForMail('friend@x.io')).body), /#\/register\?invite=/);
  await admin.ok('PUT', '/api/admin/settings', { requireEmailVerification: false });
});

// ---------- Anki ----------
const PNG = fs.readFileSync(new URL('../public/icons/icon-192.png', import.meta.url));
function ankiCollection(file, { modern }) {
  const c = new DatabaseSync(file);
  c.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, mod INTEGER, usn INTEGER, tags TEXT, flds TEXT, sfld TEXT, csum INTEGER, flags INTEGER, data TEXT);
    CREATE TABLE cards (id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER);
    CREATE TABLE revlog (id INTEGER PRIMARY KEY, cid INTEGER, usn INTEGER, ease INTEGER, ivl INTEGER, lastIvl INTEGER, factor INTEGER, time INTEGER, type INTEGER);`);
  if (modern) c.exec("CREATE TABLE decks (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO decks VALUES (10, 'Spanish\x1fVerbs');");
  else {
    c.exec('CREATE TABLE col (id INTEGER PRIMARY KEY, decks TEXT)');
    c.prepare('INSERT INTO col VALUES (1, ?)').run(JSON.stringify({ 10: { id: 10, name: 'Spanish::Verbs' } }));
  }
  const ins = c.prepare('INSERT INTO notes (id, tags, flds) VALUES (?, ?, ?)');
  ins.run(1, ' food verb ', 'comer<br><img src="cat.png">\x1f<b>to eat</b> [sound:missing.mp3]\x1fextra field');
  ins.run(2, '', '{{c1::Hola}} amigo\x1fgreeting');
  ins.run(3, '', 'beber\x1fto drink');
  const card = c.prepare('INSERT INTO cards VALUES (?, ?, ?, ?)');
  card.run(100, 1, 10, 0); card.run(101, 1, 10, 1); card.run(200, 2, 10, 0); card.run(300, 3, 10, 0);
  const day = 86_400_000, t0 = Date.now() - 20 * day;
  const rev = c.prepare('INSERT INTO revlog (id, cid, ease, type) VALUES (?, ?, ?, ?)');
  rev.run(t0, 100, 3, 0); rev.run(t0 + 600_000, 100, 3, 0); rev.run(t0 + 3 * day, 100, 3, 1); rev.run(t0 + 4 * day, 300, 1, 0);
  c.close();
  return fs.readFileSync(file);
}
// protobuf MediaEntries { repeated MediaEntry entries = 1 } with MediaEntry { string name = 1; uint32 size = 2 }
function mediaProto(names) {
  const parts = names.map((n) => {
    const name = Buffer.from(n);
    const entry = Buffer.concat([Buffer.from([0x0a, name.length]), name, Buffer.from([0x10, 5])]);
    return Buffer.concat([Buffer.from([0x0a, entry.length]), entry]);
  });
  return Buffer.concat(parts);
}

test('Anki import: legacy .apkg (JSON media map) with decks, cloze, reverse, images, tags and history', async () => {
  const cid = (await admin.ok('POST', '/api/courses', { title: 'Spanish' })).id;
  const colFile = path.join(dir, 'legacy.anki2');
  const apkg = Buffer.from(zipSync({ 'collection.anki2': new Uint8Array(ankiCollection(colFile, { modern: false })), media: new TextEncoder().encode('{"0":"cat.png"}'), 0: new Uint8Array(PNG) }));
  const r = await admin.ok('POST', `/api/courses/${cid}/import/anki?history=1`, apkg, { 'Content-Type': 'application/octet-stream' });
  assert.deepEqual([r.sets, r.cards], [1, 3]);
  assert.equal(r.reviews, 4);
  const course = await admin.ok('GET', `/api/courses/${cid}`);
  assert.equal(course.sets[0].title, 'Spanish › Verbs');
  assert.equal(course.sets[0].reverse, 1, 'a reverse card in the deck turns on reverse study');
  const set = await admin.ok('GET', `/api/sets/${course.sets[0].id}`);
  const comer = set.cards.find((c) => c.front.startsWith('comer'));
  assert.match(comer.front, /!\[\]\(\/uploads\/[a-f0-9]{32}\.png\)/);
  assert.equal(comer.back.trim(), '**to eat**');
  assert.equal(comer.notes, 'extra field');
  assert.equal(comer.tags, 'food,verb');
  assert.equal(comer.progress.find((p) => p.variant === 0).state, 2, 'history replayed into review state');
  assert.ok(set.cards.some((c) => c.type === 'cloze' && c.front.includes('{{c1::Hola}}')));
});

test('Anki import: modern .apkg (zstd collection + protobuf media) wins over the legacy stub', async () => {
  const cid = (await admin.ok('POST', '/api/courses', { title: 'Spanish 2' })).id;
  const modern = ankiCollection(path.join(dir, 'modern.anki21b'), { modern: true });
  const stub = path.join(dir, 'stub.anki2');
  const s = new DatabaseSync(stub);
  s.exec("CREATE TABLE col (id INTEGER, decks TEXT); INSERT INTO col VALUES (1, '{}'); CREATE TABLE notes (id INTEGER, tags TEXT, flds TEXT); INSERT INTO notes VALUES (1, '', 'Please update Anki'); CREATE TABLE cards (id INTEGER, nid INTEGER, did INTEGER, ord INTEGER);");
  s.close();
  const apkg = Buffer.from(zipSync({
    'collection.anki2': new Uint8Array(fs.readFileSync(stub)),
    'collection.anki21b': new Uint8Array(zlib.zstdCompressSync(modern)),
    media: new Uint8Array(zlib.zstdCompressSync(mediaProto(['cat.png']))),
    0: new Uint8Array(zlib.zstdCompressSync(PNG)),
  }));
  const r = await admin.ok('POST', `/api/courses/${cid}/import/anki`, apkg, { 'Content-Type': 'application/octet-stream' });
  assert.equal(r.cards, 3);
  const course = await admin.ok('GET', `/api/courses/${cid}`);
  const set = await admin.ok('GET', `/api/sets/${course.sets[0].id}`);
  assert.ok(set.cards.some((c) => /\/uploads\/[a-f0-9]{32}\.png/.test(c.front)), 'zstd media decoded');
  assert.ok(!set.cards.some((c) => c.front.includes('Please update')));
  const bad = await admin.call('POST', `/api/courses/${cid}/import/anki`, Buffer.from('not a zip'), { 'Content-Type': 'application/octet-stream' });
  assert.equal(bad.status, 400);
});

test('Anki import: rejects collections whose notes are a view, and zip bombs', async () => {
  const cid = (await admin.ok('POST', '/api/courses', { title: 'Evil' })).id;
  const f = path.join(dir, 'view.anki2');
  const c = new DatabaseSync(f);
  c.exec(`CREATE TABLE col (id INTEGER, decks TEXT); INSERT INTO col VALUES (1, '{}'); CREATE TABLE cards (id INTEGER, nid INTEGER, did INTEGER, ord INTEGER);
    CREATE VIEW notes AS WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n) SELECT id, '' AS flds, '' AS tags FROM n;`);
  c.close();
  const apkg = Buffer.from(zipSync({ 'collection.anki2': new Uint8Array(fs.readFileSync(f)) }));
  const r = await admin.call('POST', `/api/courses/${cid}/import/anki`, apkg, { 'Content-Type': 'application/octet-stream' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /missing tables/);
  // 25 MB of zeros in a tiny zip, over the 20 MB unpacked cap: refused from the declared sizes, before inflating.
  const bomb = Buffer.from(zipSync({ 'collection.anki2': new Uint8Array(25 * 1048576) }, { level: 9 }));
  const b = await admin.call('POST', `/api/courses/${cid}/import/anki`, bomb, { 'Content-Type': 'application/octet-stream' });
  assert.equal(b.status, 400);
  assert.match(b.data.error, /too large when unpacked/);
});

test('MFA: five wrong codes lock the account out of the second step', async () => {
  const u = client();
  await admin.ok('POST', '/api/admin/users', { email: 'mfa@x.io', password: 'password123' });
  await u.ok('POST', '/api/auth/login', { email: 'mfa@x.io', password: 'password123' });
  const setup = await u.ok('POST', '/api/account/totp/setup');
  await u.ok('POST', '/api/account/totp/enable', { ticket: setup.ticket, code: hotp(setup.secret, Math.floor(Date.now() / 30_000)) });
  const t = (await client().ok('POST', '/api/auth/login', { email: 'mfa@x.io', password: 'password123' })).ticket;
  for (let i = 0; i < 5; i++) assert.equal((await client().call('POST', '/api/auth/login/mfa', { ticket: t, code: '000000' })).status, 401);
  const locked = await client().call('POST', '/api/auth/login/mfa', { ticket: t, code: hotp(setup.secret, Math.floor(Date.now() / 30_000) + 1) });
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /wrong codes/);
});

test('account: first password on an SSO-only account needs a recent sign-in; password checks are rate limited', async () => {
  const u = client();
  await admin.ok('POST', '/api/admin/users', { email: 'sso@x.io', password: 'password123' });
  await u.ok('POST', '/api/auth/login', { email: 'sso@x.io', password: 'password123' });
  const uid = (await db.get('SELECT id FROM users WHERE email = ?', 'sso@x.io')).id;
  await db.run('UPDATE users SET password_hash = NULL WHERE id = ?', uid);
  await db.run('UPDATE sessions SET created_at = ? WHERE user_id = ?', Date.now() - 3_600_000, uid);
  const stale = await u.call('POST', '/api/account/password', { password: 'brandnew123' });
  assert.equal(stale.status, 403);
  assert.equal(stale.data.code, 'reauth_required');
  await db.run('UPDATE sessions SET created_at = ? WHERE user_id = ?', Date.now(), uid);
  await u.ok('POST', '/api/account/password', { password: 'brandnew123' });
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await u.call('POST', '/api/account/password', { current: 'wrong', password: 'whatever123' })).status);
  assert.deepEqual([codes[0], codes.at(-1)], [401, 429]);
});

test('scheduled backup job writes an auto backup and prunes old ones', async () => {
  await admin.ok('PUT', '/api/admin/backups/schedule', { enabled: true, hour: 0, keep: 1 });
  await tick();
  let list = (await admin.ok('GET', '/api/admin/backups')).files.filter((f) => f.kind === 'auto');
  assert.equal(list.length, 1);
  await db.run("DELETE FROM settings WHERE key = 'job_backup'"); // pretend a day passed
  await new Promise((r) => setTimeout(r, 1100)); // distinct timestamped filename
  await tick();
  list = (await admin.ok('GET', '/api/admin/backups')).files.filter((f) => f.kind === 'auto');
  assert.equal(list.length, 1, 'keep=1 prunes the older auto backup');
});

test('push: key, subscription validation, reminder job survives unreachable endpoints', async () => {
  const { publicKey } = await admin.ok('GET', '/api/push/key');
  assert.ok(publicKey.length > 40);
  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  for (const endpoint of ['http://insecure', 'https://127.0.0.1:1/push/abc', 'https://evil.example/push', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x']) {
    assert.equal((await admin.call('POST', '/api/push/subscribe', { endpoint, keys })).status, 400, endpoint);
  }
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc']) {
    await admin.ok('POST', '/api/push/subscribe', { endpoint, keys });
    await admin.ok('POST', '/api/push/unsubscribe', { endpoint });
  }
  // The reminder job must survive an unreachable endpoint; the allowlist keeps clients from storing one, so insert it directly.
  const adminId = (await db.get('SELECT id FROM users WHERE email = ?', 'admin@x.io')).id;
  await db.run('INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)', 'https://127.0.0.1:1/push/abc', adminId, keys.p256dh, keys.auth, Date.now());
  await admin.ok('PUT', '/api/account/prefs', { reminder: '00:00', tz: 'UTC' });
  const cid = (await admin.ok('POST', '/api/courses', { title: 'Due' })).id;
  const sid = (await admin.ok('POST', `/api/courses/${cid}/sets`, { title: 'S' })).id;
  const card = (await admin.ok('POST', `/api/sets/${sid}/cards`, { front: 'q', back: 'a' })).ids[0];
  await admin.ok('PUT', `/api/courses/${cid}/prefs`, { steps: [] });
  await admin.ok('POST', '/api/review', { cardId: card, variant: 0, rating: 1, ts: Date.now() - 20 * 86_400_000 });
  await tick(); // sends (and fails) without throwing
  const prefs = await admin.ok('GET', '/api/account/prefs');
  assert.equal(prefs.lastReminder, new Date().toISOString().slice(0, 10), 'reminder marked as handled today');
});
