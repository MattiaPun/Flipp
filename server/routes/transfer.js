// Moving content in and out: course export/import (.tar.gz with media) and Anki .apkg import.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Router } from 'express';
import { unzipSync } from 'fflate';
import { db, UPLOAD_DIR } from '../db.js';
import { httpError, now } from '../util.js';
import { loadCourse } from '../access.js';
import { audit } from '../audit.js';
import { sniff, maxBytes } from '../storage.js';
import { tarGzWriter, readTarGz } from '../archive.js';
import { cardInput } from './content.js';
import { schedule } from '../../public/srs.js';
import { courseConfig } from '../study-core.js';

export const transferRouter = Router();
const REF = /\/uploads\/([a-f0-9]{32}\.[a-z0-9]{3,4})/g;
const MAX_MB = Number(process.env.MAX_IMPORT_MB || 300);
// Unpacked size cap for imports: generous for real decks, but stops zip/gzip/zstd bombs.
const MAX_UNPACKED = MAX_MB * 4 * 1048576;

// Stream the raw request body to a temp file (bounded), returning its path.
async function bodyToTemp(req) {
  const file = path.join(os.tmpdir(), `flipp-import-${crypto.randomBytes(8).toString('hex')}`);
  let size = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    req.on('data', (c) => { size += c.length; if (size > MAX_MB * 1048576) { req.destroy(); out.destroy(); reject(httpError(413, `File too large (max ${MAX_MB} MB)`)); } });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    req.pipe(out);
  }).catch(async (e) => { await fsp.rm(file, { force: true }); throw e; });
  if (!size) { await fsp.rm(file, { force: true }); throw httpError(400, 'Empty upload'); }
  return file;
}

// Stores a media buffer as a new upload owned by `userId`. Returns its /uploads URL, or null if not an allowed type.
async function storeMedia(buf, userId) {
  const type = sniff(buf);
  if (!type || buf.length > maxBytes(type.kind)) return null;
  const name = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
  await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
  await db.run('INSERT INTO uploads (name, user_id, size, kind, created_at) VALUES (?, ?, ?, ?, ?)', name, userId, buf.length, type.kind, now());
  return { url: `/uploads/${name}`, kind: type.kind };
}

// Creates sets + cards inside one transaction. sets: [{ title, description, reverse, cards: [cardInput-shaped] }]
async function insertSets(courseId, sets) {
  return db.tx(async (t) => {
    const ids = [];
    for (const s of sets) {
      const row = await t.get('INSERT INTO sets (course_id, title, description, reverse, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
        courseId, s.title.slice(0, 120) || 'Imported', (s.description || '').slice(0, 2000), s.reverse ? 1 : 0, now());
      const cardIds = [];
      let pos = 0;
      for (const c of s.cards) {
        cardIds.push((await t.get(`INSERT INTO cards (set_id, front, back, image, position, created_at, updated_at, type, notes, mnemonic, example, audio, tags)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, row.id, c.front, c.back, c.image, pos++, now(), now(), c.type, c.notes, c.mnemonic, c.example, c.audio, c.tags)).id);
      }
      ids.push({ setId: row.id, cardIds });
    }
    return ids;
  });
}

// ---------- Course export / import ----------
transferRouter.get('/courses/:id/export', async (req, res) => {
  const c = await loadCourse(req, req.params.id);
  const sets = await db.all('SELECT * FROM sets WHERE course_id = ? ORDER BY created_at, id', c.id);
  const media = new Set();
  const out = { format: 'flipp-course', version: 1, exported_at: new Date().toISOString(),
    course: { title: c.title, description: c.description, icon: c.icon, tags: c.tags, lang: c.lang }, sets: [] };
  for (const s of sets) {
    const cards = await db.all('SELECT type, front, back, notes, mnemonic, example, image, audio, tags FROM cards WHERE set_id = ? ORDER BY position, id', s.id);
    for (const k of cards) for (const v of Object.values(k)) for (const m of String(v || '').matchAll(REF)) media.add(m[1]);
    out.sets.push({ title: s.title, description: s.description, reverse: !!s.reverse, cards });
  }
  const name = c.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'course';
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}.flipp.tar.gz"` });
  const w = tarGzWriter(res);
  await w.addBuffer('course.json', Buffer.from(JSON.stringify(out, null, 2)));
  for (const m of media) {
    const p = path.join(UPLOAD_DIR, m);
    if (fs.existsSync(p)) await w.addFile(`media/${m}`, p);
  }
  await w.finish();
});

// Body: a .flipp.tar.gz from the export above. Creates a new course owned by the caller.
transferRouter.post('/courses/import', async (req, res) => {
  const file = await bodyToTemp(req);
  try {
    let data = null;
    const media = new Map();
    let mediaBytes = 0;
    try {
      for await (const e of readTarGz(fs.createReadStream(file), { maxEntryBytes: 64 * 1048576, maxTotalBytes: MAX_UNPACKED })) {
        if (e.name === 'course.json') data = JSON.parse(e.data.toString());
        else if (/^media\/[a-f0-9]{32}\.[a-z0-9]{3,4}$/.test(e.name)) {
          mediaBytes += e.data.length;
          media.set(path.basename(e.name), e.data);
        }
      }
    } catch (e) { throw e.status ? e : httpError(400, `Not a valid Flipp course export (${e.message})`); }
    if (data?.format !== 'flipp-course' || !Array.isArray(data.sets)) throw httpError(400, 'Not a Flipp course export');
    const total = data.sets.reduce((n, s) => n + (Array.isArray(s.cards) ? s.cards.length : 0), 0);
    if (total > 50_000) throw httpError(400, 'Too many cards in one course');
    const renamed = new Map();
    for (const [oldName, buf] of media) { const r = await storeMedia(buf, req.user.id); if (r) renamed.set(oldName, r.url); }
    const fix = (v) => (typeof v === 'string' ? v.replace(REF, (m, n) => renamed.get(n) || m) : v);
    const sets = data.sets.map((s) => ({
      title: String(s.title || 'Imported'), description: String(s.description || ''), reverse: !!s.reverse,
      cards: (s.cards || []).map((k) => { const f = Object.fromEntries(Object.entries(k).map(([key, v]) => [key, fix(v)])); return cardInput({ ...f, image: renamed.has(path.basename(k.image || '')) ? f.image : null, audio: renamed.has(path.basename(k.audio || '')) ? f.audio : null }); }),
    }));
    const co = data.course || {};
    const course = await db.get('INSERT INTO courses (owner_id, title, description, icon, tags, lang, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      req.user.id, String(co.title || 'Imported course').slice(0, 120), String(co.description || '').slice(0, 2000), String(co.icon || '').slice(0, 16), String(co.tags || '').slice(0, 300), String(co.lang || '').slice(0, 20), 'private', now());
    await insertSets(course.id, sets);
    await audit(req, 'course.imported', { target: `course:${course.id}`, details: { cards: total } });
    res.json({ id: course.id, cards: total });
  } finally {
    await fsp.rm(file, { force: true });
  }
});

// ---------- Anki .apkg import ----------
const zstd = (buf, max = MAX_UNPACKED) => (buf.length > 4 && buf.readUInt32LE(0) === 0xfd2fb528 ? zlib.zstdDecompressSync(buf, { maxOutputLength: max }) : buf);
const MEDIA_MAX = Math.max(maxBytes('image'), maxBytes('audio'));
// Only the collection, the media index and the numbered media files are read; nothing else is inflated.
const ANKI_ENTRY = /^(collection\.anki2|collection\.anki21|collection\.anki21b|media|\d+)$/;

// Minimal protobuf reader for Anki's media index: MediaEntries { repeated MediaEntry entries = 1 } MediaEntry { string name = 1; ... }
function parseMediaEntries(buf) {
  const names = [];
  let i = 0;
  const varint = () => { let x = 0, s = 0, b; do { b = buf[i++]; x += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return x; };
  while (i < buf.length) {
    const key = varint();
    if ((key & 7) !== 2) throw new Error('media index: unexpected wire type');
    const len = varint();
    const end = i + len;
    if (key >>> 3 === 1) {
      let name = '';
      let legacy = null;
      while (i < end) {
        const k = varint(), wt = k & 7, field = k >>> 3;
        if (wt === 2) { const l = varint(); if (field === 1) name = buf.subarray(i, i + l).toString('utf8'); i += l; }
        else if (wt === 0) { const v = varint(); if (field === 255) legacy = v; }
        else throw new Error('media index: unsupported field');
      }
      names.push({ name, file: legacy ?? names.length });
    }
    i = end;
  }
  return new Map(names.map((n, idx) => [n.name, String(n.file ?? idx)]));
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Anki field HTML -> Markdown (+ collected media references).
function htmlToMd(h, media) {
  let s = String(h || '');
  s = s.replace(/\[sound:([^\]]+)\]/g, (_, f) => { media.sounds.push(f); return ''; });
  s = s.replace(/<img[^>]*src=["']?([^"' >]+)["']?[^>]*>/gi, (_, f) => { media.images.push(decodeURIComponent(f)); return `\u0000IMG${media.images.length - 1}\u0000`; });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*').replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// Body: the .apkg file. Query: history=1 to also import your own review history from the deck.
transferRouter.post('/courses/:id/import/anki', async (req, res) => {
  const course = await loadCourse(req, req.params.id, 'edit');
  const withHistory = req.query.history === '1';
  const file = await bodyToTemp(req);
  const dbFile = `${file}.sqlite`;
  let col;
  try {
    let zip;
    let declared = 0;
    // Declared sizes bound what fflate inflates (it allocates exactly originalSize), so summing them caps memory.
    const filter = (f) => {
      if (!ANKI_ENTRY.test(f.name)) return false;
      if ((declared += f.originalSize) > MAX_UNPACKED) throw httpError(400, `This deck is too large when unpacked (max ${MAX_UNPACKED / 1048576} MB)`);
      return true;
    };
    try { zip = unzipSync(new Uint8Array(await fsp.readFile(file)), { filter }); } catch (e) { throw e.status ? e : httpError(400, 'Not a valid .apkg file (expected a zip archive)'); }
    let colBuf;
    try { colBuf = zip['collection.anki21b'] ? zstd(Buffer.from(zip['collection.anki21b'])) : zip['collection.anki21'] || zip['collection.anki2']; }
    catch { throw httpError(400, 'The Anki collection in this file is too large or corrupt'); }
    if (!colBuf) throw httpError(400, 'No Anki collection found in this file');
    await fsp.writeFile(dbFile, Buffer.from(colBuf));
    const { DatabaseSync } = await import('node:sqlite');
    col = new DatabaseSync(dbFile, { readOnly: true });
    // Only real tables: a crafted file could define notes/cards as (recursive) views that never finish.
    const hasTable = (n) => !!col.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? AND sql NOT LIKE 'CREATE VIRTUAL%'").get(n);
    if (!hasTable('notes') || !hasTable('cards') || !(hasTable('decks') || hasTable('col'))) throw httpError(400, 'Not a valid Anki collection (missing tables)');

    // Media index: filename -> zip entry name.
    let mediaMap = new Map();
    if (zip.media) {
      let raw;
      try { raw = zstd(Buffer.from(zip.media)); } catch { throw httpError(400, 'The media index in this file is too large or corrupt'); }
      try { mediaMap = new Map(Object.entries(JSON.parse(raw.toString('utf8'))).map(([k, v]) => [v, k])); }
      catch { mediaMap = parseMediaEntries(raw); }
    }

    // Decks (id -> name). Schema 18 has a decks table; older ones keep JSON in col.decks.
    const decks = new Map();
    if (hasTable('decks')) for (const d of col.prepare('SELECT id, name FROM decks').all()) decks.set(String(d.id), String(d.name).replace(/\x1f/g, ' › '));
    else for (const d of Object.values(JSON.parse(col.prepare('SELECT decks FROM col').get().decks))) decks.set(String(d.id), d.name.replace(/::/g, ' › '));

    const notes = col.prepare('SELECT id, flds, tags FROM notes').all();
    const cards = col.prepare('SELECT id, nid, did, ord FROM cards ORDER BY id').all();
    const byNote = new Map();
    for (const c of cards) (byNote.get(c.nid) || byNote.set(c.nid, []).get(c.nid)).push(c);

    // Group notes by the deck of their first card; one Flipp set per deck.
    const groups = new Map();
    let mediaBytes = 0;
    const mediaCache = new Map();
    const getMedia = async (name) => {
      if (mediaCache.has(name)) return mediaCache.get(name);
      const entry = mediaMap.get(name);
      let result = null;
      let buf = null;
      if (entry && zip[entry]) try { buf = zstd(Buffer.from(zip[entry]), MEDIA_MAX + 1); } catch { /* larger than any allowed upload: skip */ }
      if (buf) {
        mediaBytes += buf.length;
        result = await storeMedia(buf, req.user.id);
      }
      mediaCache.set(name, result);
      return result;
    };
    for (const n of notes) {
      const fields = String(n.flds).split('\x1f');
      const nc = byNote.get(n.id) || [];
      const deckName = decks.get(String(nc[0]?.did)) || 'Imported';
      const media = { images: [], sounds: [] };
      const isCloze = /\{\{c\d+::/.test(fields[0] || '');
      let front = htmlToMd(fields[0], media);
      let back = htmlToMd(fields[1] || '', media);
      const notesText = fields.slice(2).map((f) => htmlToMd(f, media)).filter(Boolean).join('\n\n');
      const imgUrls = [];
      for (const img of media.images) imgUrls.push((await getMedia(img))?.url || '');
      const swap = (s) => s.replace(/\u0000IMG(\d+)\u0000/g, (_, i) => (imgUrls[i] ? `![](${imgUrls[i]})` : ''));
      front = swap(front) || (isCloze ? '' : '(empty)');
      back = swap(back);
      let audio = null;
      for (const snd of media.sounds) { const m = await getMedia(snd); if (m?.kind === 'audio') { audio = m.url; break; } }
      let card;
      try {
        card = cardInput({ type: isCloze ? 'cloze' : 'basic', front: front.slice(0, 20000) || '(empty)', back: back.slice(0, 20000), notes: swap(notesText).slice(0, 5000), audio, tags: String(n.tags || '').trim().split(/\s+/).join(',') });
      } catch { continue; } // skip notes we can't represent (e.g. broken cloze)
      const g = groups.get(deckName) || groups.set(deckName, { title: deckName, cards: [], ankiCards: [], reverse: false }).get(deckName);
      if (!isCloze && nc.some((c) => c.ord === 1)) g.reverse = true;
      g.cards.push(card);
      g.ankiCards.push(nc.map((c) => ({ id: c.id, variant: isCloze ? c.ord + 1 : c.ord })));
    }
    if (!groups.size) throw httpError(400, 'No notes found in this deck');
    const created = await insertSets(course.id, [...groups.values()]);

    // Optional: replay this deck's review log so scheduling continues where Anki left off.
    let reviews = 0;
    if (withHistory && hasTable('revlog')) {
      const cardMap = new Map();
      [...groups.values()].forEach((g, gi) => g.ankiCards.forEach((list, ci) => list.forEach((ac) => cardMap.set(ac.id, { cardId: created[gi].cardIds[ci], variant: ac.variant }))));
      const config = await courseConfig(req.user.id, course.id);
      const state = new Map();
      for (const r of col.prepare('SELECT id, cid, ease, type FROM revlog WHERE ease IN (1, 2, 3, 4) AND type < 3 ORDER BY id').all()) {
        const target = cardMap.get(r.cid);
        if (!target) continue;
        const key = `${target.cardId}:${target.variant}`;
        const prev = state.get(key) || null;
        const ts = Math.round(Number(r.id)); // BIGINT column; a crafted revlog may hold REALs
        state.set(key, { ...schedule(prev, Number(r.ease), ts, { config }), wasNew: !prev, prevState: prev?.state ?? 0, ...target, ts, rating: Number(r.ease), reviews: [...(prev?.reviews || []), { ts, rating: Number(r.ease), wasNew: !prev, state: prev?.state ?? 0 }] });
      }
      await db.tx(async (t) => {
        for (const p of state.values()) {
          for (const v of p.reviews) {
            await t.run('INSERT INTO reviews (user_id, card_id, variant, rating, prev, ts, was_new, state) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)', req.user.id, p.cardId, p.variant, v.rating, v.ts, v.wasNew ? 1 : 0, v.state);
            reviews++;
          }
          await t.run(`INSERT INTO progress (user_id, card_id, variant, state, step, stability, difficulty, lapses, reps, last_reviewed, next_due)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, card_id, variant) DO NOTHING`,
            req.user.id, p.cardId, p.variant, p.state, p.step, p.stability, p.difficulty, p.lapses, p.reps, p.last_reviewed, Math.round(p.next_due));
        }
      });
    }
    const total = [...groups.values()].reduce((n, g) => n + g.cards.length, 0);
    await audit(req, 'course.anki_imported', { target: `course:${course.id}`, details: { notes: total, sets: groups.size, reviews, mediaBytes } });
    res.json({ sets: groups.size, cards: total, reviews });
  } finally {
    try { col?.close(); } catch {}
    await fsp.rm(file, { force: true });
    await fsp.rm(dbFile, { force: true });
  }
});
