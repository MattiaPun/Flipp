// Minimal streaming .tar.gz writer/reader (ustar, regular files only). Used by backups and data exports.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { once } from 'node:events';

const BLOCK = 512;

function header(name, size, mtime = Date.now()) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar: name too long: ${name}`);
  const h = Buffer.alloc(BLOCK);
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime / 1000), 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder (spaces)
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

const pad = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

// Returns a writer that streams a gzip-compressed tar into `out`.
export function tarGzWriter(out) {
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(out);
  const write = async (buf) => { if (!gz.write(buf)) await once(gz, 'drain'); };
  return {
    async addBuffer(name, buf) {
      await write(header(name, buf.length));
      await write(buf);
      await write(pad(buf.length));
    },
    async addFile(name, file) {
      const { size, mtimeMs } = await fs.promises.stat(file);
      await write(header(name, size, mtimeMs));
      let written = 0;
      for await (const chunk of fs.createReadStream(file)) { await write(chunk); written += chunk.length; }
      if (written !== size) throw new Error(`tar: ${file} changed while archiving`);
      await write(pad(size));
    },
    async finish() {
      await write(Buffer.alloc(BLOCK * 2));
      gz.end();
      await once(out, 'finish');
    },
  };
}

// Async iterator over { name, data } entries of a .tar.gz readable stream. Rejects entries above maxEntryBytes,
// and archives whose declared sizes or entry count exceed the totals (a small gzip can unpack to gigabytes).
export async function* readTarGz(input, { maxEntryBytes = 64 * 1048576, maxTotalBytes = 2 * 1024 ** 3, maxEntries = 100_000 } = {}) {
  let buf = Buffer.alloc(0);
  let total = 0, count = 0;
  let entry = null; // { name, size, chunks, got }
  const gunzip = input.pipe(zlib.createGunzip());
  input.on('error', (e) => gunzip.destroy(e));
  for await (const chunk of gunzip) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (!entry) {
        if (buf.length < BLOCK) break;
        const h = buf.subarray(0, BLOCK);
        buf = buf.subarray(BLOCK);
        if (h.every((b) => b === 0)) continue; // end-of-archive padding
        const field = (off, len) => h.subarray(off, off + len).toString('utf8').replace(/\0.*$/s, '');
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
        if (parseInt(field(148, 8).trim(), 8) !== sum) throw new Error('tar: bad header checksum (not a Flipp archive?)');
        const size = parseInt(field(124, 12).trim() || '0', 8);
        if (!(size <= maxEntryBytes)) throw new Error('tar: entry too large'); // also rejects a NaN size field
        if ((total += size) > maxTotalBytes) throw new Error('tar: archive too large when unpacked');
        if (++count > maxEntries) throw new Error('tar: too many entries');
        const prefix = field(345, 155);
        entry = { name: (prefix ? `${prefix}/` : '') + field(0, 100), type: field(156, 1) || '0', size, chunks: [], got: 0 };
      }
      const need = entry.size - entry.got;
      const take = Math.min(need, buf.length);
      if (take) { entry.chunks.push(buf.subarray(0, take)); entry.got += take; buf = buf.subarray(take); }
      if (entry.got < entry.size) break;
      const padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
      if (buf.length < padding) break;
      buf = buf.subarray(padding);
      const done = entry;
      entry = null;
      if (done.type === '0') yield { name: done.name, data: Buffer.concat(done.chunks) };
    }
  }
  if (entry) throw new Error('tar: archive is truncated');
}
