// Upload bookkeeping: magic-byte sniffing, ownership rows, orphan cleanup.
import fs from 'node:fs/promises';
import path from 'node:path';
import { db, UPLOAD_DIR } from './db.js';
import { now } from './util.js';
import { branding } from './branding.js';

const IMAGE_MAX = 8 * 1048576, AUDIO_MAX = 5 * 1048576;

// Returns { ext, kind } for allowed formats, else null. Never SVG/HTML (would be an XSS vector).
export function sniff(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  const ascii = (a, b) => buf.subarray(a, b).toString('latin1');
  if (hex.startsWith('89504e47')) return { ext: 'png', kind: 'image' };
  if (hex.startsWith('ffd8ff')) return { ext: 'jpg', kind: 'image' };
  if (hex.startsWith('47494638')) return { ext: 'gif', kind: 'image' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', kind: 'image' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { ext: 'wav', kind: 'audio' };
  if (hex.startsWith('1a45dfa3')) return { ext: 'webm', kind: 'audio' };
  if (ascii(0, 4) === 'OggS') return { ext: 'ogg', kind: 'audio' };
  if (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ext: 'mp3', kind: 'audio' };
  if (ascii(4, 8) === 'ftyp') return { ext: 'm4a', kind: 'audio' };
  return null;
}
export const maxBytes = (kind) => (kind === 'audio' ? AUDIO_MAX : IMAGE_MAX);

const REF = /\/uploads\/([a-f0-9]{32}\.[a-z0-9]{3,4})/g;

// Every upload name referenced anywhere (card fields, markdown, branding).
async function referenced() {
  const refs = new Set();
  const add = (text) => { for (const m of String(text || '').matchAll(REF)) refs.add(m[1]); };
  for (const c of await db.all('SELECT image, audio, front, back, notes, mnemonic, example FROM cards')) Object.values(c).forEach(add);
  add((await branding()).logo);
  return refs;
}

// Registers untracked files (e.g. from before ownership tracking) and lists orphans older than `graceMs`.
export async function scanUploads(graceMs = 24 * 3_600_000) {
  const names = (await fs.readdir(UPLOAD_DIR)).filter((n) => /^[a-f0-9]{32}\.[a-z0-9]{3,4}$/.test(n));
  const tracked = new Map((await db.all('SELECT name, created_at, size FROM uploads')).map((u) => [u.name, u]));
  for (const n of names) {
    if (tracked.has(n)) continue;
    const st = await fs.stat(path.join(UPLOAD_DIR, n));
    const kind = /\.(png|jpg|gif|webp)$/.test(n) ? 'image' : 'audio';
    const created = Math.floor(st.mtimeMs); // fractional ms; the column is BIGINT
    await db.run('INSERT INTO uploads (name, user_id, size, kind, created_at) VALUES (?, NULL, ?, ?, ?) ON CONFLICT (name) DO NOTHING', n, st.size, kind, created);
    tracked.set(n, { name: n, created_at: created, size: st.size });
  }
  const refs = await referenced();
  const cutoff = now() - graceMs;
  const orphans = names.filter((n) => !refs.has(n) && tracked.get(n).created_at < cutoff);
  return { files: names.length, orphans, orphanBytes: orphans.reduce((s, n) => s + Number(tracked.get(n).size), 0) };
}

export async function cleanupOrphans() {
  const { orphans, orphanBytes } = await scanUploads();
  for (const n of orphans) {
    await fs.rm(path.join(UPLOAD_DIR, n), { force: true });
    await db.run('DELETE FROM uploads WHERE name = ?', n);
  }
  // Rows whose file vanished.
  const disk = new Set(await fs.readdir(UPLOAD_DIR));
  for (const u of await db.all('SELECT name FROM uploads')) if (!disk.has(u.name)) await db.run('DELETE FROM uploads WHERE name = ?', u.name);
  return { removed: orphans.length, bytes: orphanBytes };
}
