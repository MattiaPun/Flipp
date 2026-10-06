# Flipp

Flipp is a self-hosted flashcard and spaced-repetition app. It ships as one container. Node (Express 5) serves the JSON API and the static frontend from the same process. Data lives in `/data`: SQLite in WAL mode, or PostgreSQL when `DATABASE_URL` is set.

- `server/`: API, auth, DB, scheduler. See [server/CLAUDE.md](server/CLAUDE.md).
- `public/`: browser app with no build step. See [public/CLAUDE.md](public/CLAUDE.md).

## Commands

```bash
npm install
npm run dev                  # http://localhost:3000, data in ./data, auto-restart
npm test                     # node:test, server/*.test.js
docker compose up -d --build # production-like run
```

Node version: ≥ 22.13, because the app uses the built-in `node:sqlite`. Docker and CI use Node 24.

## Principles

- **Simple first.** Before adding code, check in this order:
  1. Does the platform already do it?
  2. Does the stdlib?
  3. Does an installed dependency?

  Write new code only after that. Adding a dependency needs a real reason, written in the PR. The app currently has 6 runtime dependencies (`express`, `pg`, `htm`, `marked`, `dompurify`, `katex`).
- **One container, one process, one data folder.** No sidecars, no Redis, no separate frontend server.
- **No build step.** The browser loads ES modules directly. Do not add a bundler, TypeScript, JSX, or a CSS preprocessor.
- **Match the existing code.** Use the same naming, density, and comment style. Comments explain *why*, not *what*.
- **Mark deliberate shortcuts** with `// ponytail: <limit>, <upgrade path>` so they can be found later.
- **Pure logic goes in `public/lib.js`.** It runs in both the browser and Node. Tests go in `server/core.test.js`. Any non-trivial logic (scheduling, queue, grading, parsing) needs at least one assertion there.

## Security rules (non-negotiable)

- **SQL:** parameterized only, with `?` placeholders. Never interpolate user input into SQL.
- **Every write route** loads its resource through `loadCourse`, `loadSet`, or `loadCard` with `write = true`. These enforce ownership and admin rights. Inaccessible resources return 404, not 403, so their existence is not leaked.
- **Validate request fields** with `str()`, `id()`, and `image()` before use. Enforce length limits.
- **CSRF:** state-changing requests need `X-Flipp: 1` plus a same-origin request. The frontend `api()` helper sends this header. Never add CORS headers.
- **CSP:** `script-src 'self'`, so no inline scripts, no inline event handlers in HTML, and no CDNs. Third-party browser libraries are served from `node_modules` through the `/vendor` routes in `server/index.js`.
- **Untrusted HTML:** render it only through `Md` / `md()`, which use DOMPurify. Do not use `dangerouslySetInnerHTML` anywhere else.
- **Uploads:** raster images only, checked by magic bytes. Never allow SVG.
- **Secrets:** never log passwords, tokens, or secrets. Never commit `.env` or `data/`.

## Git

- Branch: `main`. Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:` …).
- CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the tests and builds the image. Pushes to `main` and `v*` tags publish `ghcr.io/mattiapun/flipp` for amd64 and arm64.
- License: GPL-3.0-only. Dependencies and copied code must have GPL-compatible licenses (MIT, BSD, ISC and Apache-2.0 are fine).
