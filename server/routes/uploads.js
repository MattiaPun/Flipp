import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { db, UPLOAD_DIR } from '../db.js';
import { httpError, now } from '../util.js';
import { rateLimit } from '../auth.js';
import { sniff, maxBytes } from '../storage.js';

export const uploadsRouter = Router();

// Raw body upload. Images (PNG/JPEG/GIF/WebP, 8 MB) and audio (WebM/Ogg/MP3/M4A/WAV, 5 MB), checked by magic bytes.
uploadsRouter.post('/uploads', rateLimit(60, 60_000),
  express.raw({ type: ['image/*', 'audio/*', 'video/webm', 'video/mp4', 'application/octet-stream'], limit: '8mb' }),
  async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw httpError(400, 'Send a file body');
    const type = sniff(buf);
    if (!type) throw httpError(415, 'Only PNG, JPEG, GIF, WebP images or WebM, Ogg, MP3, M4A, WAV audio are allowed');
    if (buf.length > maxBytes(type.kind)) throw httpError(413, `File too large (max ${maxBytes(type.kind) / 1048576} MB for ${type.kind})`);
    const name = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
    await fs.writeFile(path.join(UPLOAD_DIR, name), buf);
    await db.run('INSERT INTO uploads (name, user_id, size, kind, created_at) VALUES (?, ?, ?, ?, ?)', name, req.user.id, buf.length, type.kind, now());
    res.json({ url: `/uploads/${name}`, kind: type.kind });
  });
