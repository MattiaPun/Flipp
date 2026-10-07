import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { UPLOAD_DIR } from './db.js';
import { sessionMiddleware, requireUser, PUBLIC_URL, initSetupToken } from './auth.js';
import { httpError } from './util.js';
import { authRouter } from './routes/auth.js';
import { accountRouter } from './routes/account.js';
import { contentRouter } from './routes/content.js';
import { studyRouter } from './routes/study.js';
import { uploadsRouter } from './routes/uploads.js';
import { adminRouter } from './routes/admin.js';
import { transferRouter } from './routes/transfer.js';
import { groupsRouter } from './routes/groups.js';
import { pushRouter } from './routes/push.js';
import { branding } from './branding.js';
import { startJobs } from './jobs.js';
import { maintenance } from './backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

// ---------- Security headers ----------
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      "font-src 'self' data:", "connect-src 'self'", "media-src 'self' blob:", "object-src 'none'", "base-uri 'none'",
      "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'", "worker-src 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ---------- API: CSRF + CORS boundary ----------
const PUBLIC_ORIGIN = PUBLIC_URL && new URL(PUBLIC_URL).origin; // Origin headers carry no path or trailing slash
// No CORS headers are ever sent, so browsers block cross-origin reads. State-changing requests must
// (1) come from our own origin and (2) carry the custom X-Flipp header, which cross-site forms cannot set.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return req.method === 'OPTIONS' ? res.sendStatus(204) : next();
  const origin = req.get('origin');
  const self = PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const site = req.get('sec-fetch-site');
  // Most common cause in practice: opening Flipp at another address (127.0.0.1, a LAN IP) than PUBLIC_URL.
  if (origin && origin !== self && site === 'same-origin') return next(httpError(403, `Open Flipp at ${self} (PUBLIC_URL). This address (${origin}) is not allowed to make changes.`));
  if ((origin && origin !== self) || (site && site !== 'same-origin') || req.get('x-flipp') !== '1') return next(httpError(403, 'Cross-site request blocked'));
  next();
});
app.use('/api', (req, _res, next) => next(maintenance ? httpError(503, 'Restoring a backup — back in a moment') : undefined));
app.use('/api', express.json({ limit: '2mb' }), sessionMiddleware);
app.use('/api/auth', authRouter);
app.use('/api', requireUser);
app.use('/api/account', accountRouter);
app.use('/api/admin', adminRouter);
app.use('/api', transferRouter, contentRouter, studyRouter, uploadsRouter, groupsRouter, pushRouter);
app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));

// ---------- Branding-aware PWA bits ----------
app.get('/manifest.webmanifest', async (_req, res) => {
  const b = await branding();
  const icons = [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  if (b.logo) icons.unshift({ src: b.logo, sizes: 'any', purpose: 'any' });
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
    name: b.name, short_name: b.name.slice(0, 12), description: 'Minimal, self-hosted flashcards with spaced repetition.',
    start_url: '/', scope: '/', display: 'standalone', orientation: 'any', background_color: '#0b0b0c', theme_color: '#0b0b0c', icons,
  }));
});
app.get('/branding.css', async (_req, res) => {
  const { accent } = await branding();
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) return res.type('text/css').set('Cache-Control', 'no-cache').send('');
  // Pick black or white text for buttons on the accent color (WCAG relative luminance).
  const lin = (c) => { const v = parseInt(c, 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(accent.slice(1, 3)) + 0.7152 * lin(accent.slice(3, 5)) + 0.0722 * lin(accent.slice(5, 7));
  res.type('text/css').set('Cache-Control', 'no-cache').send(`:root{--brand:${accent};--brand-text:${L > 0.4 ? '#0b0b0c' : '#ffffff'}}`);
});
app.get('/icons/apple-touch-icon.png', async (req, res, next) => {
  const { logo } = await branding();
  if (logo) return res.sendFile(path.join(UPLOAD_DIR, path.basename(logo)));
  next();
});

// ---------- Static: app shell, vendored libs, uploads ----------
const vendor = { 'htm-preact.js': 'htm/preact/standalone.module.js', 'marked.js': 'marked/lib/marked.esm.js', 'purify.js': 'dompurify/dist/purify.es.mjs' };
for (const [name, file] of Object.entries(vendor)) app.get(`/vendor/${name}`, (_req, res) => res.sendFile(path.join(NM, file), { maxAge: '7d' }));
app.use('/vendor/katex', express.static(path.join(NM, 'katex/dist'), { maxAge: '7d' }));
app.use('/vendor/webauthn', express.static(path.join(NM, '@simplewebauthn/browser/esm'), { maxAge: '7d' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '365d', immutable: true, index: false, dotfiles: 'deny' }));
app.use(express.static(path.join(ROOT, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status < 500 || err.expose ? err.message : 'Internal server error', ...(err.extra || {}) });
});

if (process.env.FLIPP_NO_LISTEN !== '1') {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`[flipp] listening on :${port}`));
  await initSetupToken();
  startJobs();
}
