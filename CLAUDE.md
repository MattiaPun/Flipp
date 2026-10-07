# Flipp

Flipp is a self-hosted flashcard and spaced-repetition app. It ships as one container. Node (Express 5) serves the JSON API and the static frontend from the same process. Data lives in `/data`: SQLite in WAL mode, or PostgreSQL when `DATABASE_URL` is set.

- `server/`: API, auth, DB, scheduler. See [server/CLAUDE.md](server/CLAUDE.md).
- `public/`: browser app with no build step. See [public/CLAUDE.md](public/CLAUDE.md).

## Commands

```bash
npm install
npm run dev                  # http://localhost:3000, data in ./data, auto-restart
npm test                     # node:test: test/core (unit), test/api (HTTP end to end), test/integrations (email, Anki, jobs, push)
TEST_DATABASE_URL=postgres://… npm test   # API tests against PostgreSQL too
npm run test:e2e             # Playwright browser tests (test/e2e)
docker compose up -d --build # production-like run
```

Node version: ≥ 22.13, because the app uses the built-in `node:sqlite`. Docker and CI use Node 24.

## Principles

- **Simple first.** Before adding code, check in this order:
  1. Does the platform already do it?
  2. Does the stdlib?
  3. Does an installed dependency?

  Write new code only after that. Adding a dependency needs a real reason, written in the PR. Current runtime dependencies: `express`, `pg`, `htm`, `marked`, `dompurify`, `katex`, `@simplewebauthn/server` + `/browser` (passkeys), `nodemailer` (SMTP), `web-push` (reminders), `fflate` (Anki zip), `qrcode-generator` (2FA QR), `@fontsource-variable/fraunces` + `@fontsource-variable/figtree` (UI fonts, OFL-1.1, served as separate files). Dev only: `@playwright/test`.
- **One container, one process, one data folder.** No sidecars, no Redis, no separate frontend server.
- **No build step.** The browser loads ES modules directly. Do not add a bundler, TypeScript, JSX, or a CSS preprocessor.
- **Match the existing code.** Use the same naming, density, and comment style. Comments explain *why*, not *what*.
- **Mark deliberate shortcuts** with `// ponytail: <limit>, <upgrade path>` so they can be found later.
- **Pure logic goes in `public/lib.js` or `public/srs.js`.** Both run in the browser and in Node. Any non-trivial logic (scheduling, queue, grading, parsing) needs at least one assertion in `test/core.test.js`.
- **Every new API route gets a test** in `test/api.test.js` (or `test/integrations.test.js` for email, files, jobs). New screens get at least a smoke step in `test/e2e/app.spec.js`.
- **Run `npm test` and `npm run test:e2e` before committing.** Both must be green.

## Security rules (non-negotiable)

- **SQL:** parameterized only, with `?` placeholders. Never interpolate user input into SQL.
- **Every content route** loads its resource through `loadCourse`, `loadSet`, or `loadCard` (`server/access.js`) with the level it needs: `'read'`, `'edit'` (owner, co-editor, admin) or `'manage'` (owner, admin: delete, share, publish). Inaccessible resources return 404, not 403, so their existence is not leaked. Group routes use `loadGroup` in `routes/groups.js`.
- **Security-relevant actions are audited** with `audit(req, 'area.action', …)` (`server/audit.js`).
- **Validate request fields** with the helpers in `server/util.js` (`str`, `id`, `int`, `email`, `image`, `audio`, `tagList`) before use. Enforce length limits. Values interpolated into SQL (e.g. `IN (…)` lists) must be integers from our own DB or `Number()`-checked.
- **CSRF:** state-changing requests need `X-Flipp: 1` plus a same-origin request. The frontend `api()` helper sends this header. Never add CORS headers.
- **CSP:** `script-src 'self'`, so no inline scripts, no inline event handlers in HTML, and no CDNs. Third-party browser libraries are served from `node_modules` through the `/vendor` routes in `server/index.js`.
- **Untrusted HTML:** render it only through `Md` / `md()`, which use DOMPurify. Do not use `dangerouslySetInnerHTML` anywhere else.
- **Uploads:** images and audio only, checked by magic bytes in `server/storage.js`. Never allow SVG or HTML.
- **Secrets at rest:** TOTP secrets are encrypted with `encrypt()`/`decrypt()` from `server/auth.js`; one-time tokens and recovery codes are stored as `tokenHash()`.
- **Secrets:** never log passwords, tokens, or secrets. Never commit `.env` or `data/`.

## Git

- Branch: `main`. Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:` …).
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the tests and builds the image. Pushes to `main` and `v*` tags publish `ghcr.io/mattiapun/flipp` for amd64 and arm64.
- License: GPL-3.0-only. Dependencies and copied code must have GPL-compatible licenses (MIT, BSD, ISC and Apache-2.0 are fine).
