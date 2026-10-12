# server/

| File | Role |
|---|---|
| `index.js` | Express app: security headers, CSRF gate, maintenance gate, router mounting, static/vendor serving, error handler |
| `db.js` | Async adapter `db.all/get/run/exec/tx` over `node:sqlite` or `pg`; append-only `migrations`; `TABLES` (FK order); settings helpers |
| `auth.js` | Sessions (with device metadata), scrypt passwords, signed tickets, AES-GCM `encrypt`, middleware (`requireUser` incl. forced 2FA setup), rate limiter, setup token |
| `access.js` | `loadCourse/loadSet/loadCard` with `'read'|'edit'|'manage'`, SQL fragments `READABLE` / `LISTED` |
| `util.js` | `httpError`, input validators, time-zone helpers (`dayKey`, `startOfDay`, `zonedParts`) |
| `study-core.js` | Card variants, the `DUE` SQL fragment, per-course config, per-user FSRS weights and time zone, `streakFor` (streaks + freeze spending), `earnFreeze` |
| `audit.js` · `storage.js` · `mailer.js` · `totp.js` | Audit log · upload sniffing + orphan cleanup · SMTP · RFC 6238 |
| `archive.js` · `backup.js` | Streaming tar.gz · portable backups and restore |
| `optimizer.js` | FSRS weight fitting (worker thread) |
| `jobs.js` | One-minute tick: daily maintenance, scheduled backups; other modules `registerJob` (reminders) |
| `routes/` | `auth` (sign-in flows, OIDC, passkey login), `account`, `content`, `study`, `transfer` (exports, Anki), `uploads`, `push`, `admin` |

The scheduler itself lives in `public/srs.js` so the browser can preview intervals with the same code.

## Database

- Write portable SQL that runs on both SQLite and PostgreSQL:
  - Use `?` placeholders. The pg adapter rewrites them to `$n`, so never put a literal `?` inside SQL strings.
  - Use `ON CONFLICT … DO UPDATE` for upserts and `RETURNING id` to get inserted ids.
  - No SQLite-only syntax (`INSERT OR IGNORE`, `AUTOINCREMENT` outside the `ID` constant) and no pg-only syntax (`ILIKE`, `::casts`).
- Store timestamps as `BIGINT` epoch milliseconds (`Date.now()`) and booleans as `INTEGER` 0/1.
- **Schema changes:** append a new string to `migrations` in `db.js`. Never edit or reorder entries that have already shipped. The version is stored in `settings.schema_version`.
- Test any change that touches SQL against Postgres too:
  `docker run -d -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=flipp -p 55432:5432 postgres:17-alpine`, then start the app with `DATABASE_URL=postgres://postgres:pw@localhost:55432/flipp`.

## Routes

- Express 5 forwards rejected promises to the error handler, so handlers can be plain `async` functions with no try/catch. To return a client error, `throw httpError(status, message)`.
- Every `/api/*` route except `/api/auth/*` already requires a logged-in user. Use `requireAdmin` for admin routes.
- Responses are JSON. Errors are `{ error: string }`. 5xx errors return a generic message and are logged to the server.
- Keep routes in `index.js` grouped by resource unless the file grows unwieldy. Split a resource into its own router file only once it becomes self-contained.

## Auth notes

- Session cookie: `flipp_session` (HttpOnly, SameSite=Lax, Secure when `PUBLIC_URL` is https). The DB stores only `HMAC(JWT_SECRET, token)`. `sessions.method` records how the session was created (`password`, `totp`, `passkey`, `oidc`, `email`); "require 2FA for admins" restricts every session except `totp`, `passkey` and `oidc`.
- Setup needs the setup token and is atomic: the first `INSERT` into `settings('setup_done')` wins.
- Restore (`backup.js`) turns on maintenance mode and the process exits afterwards so secrets and caches reload; tests set `FLIPP_NO_LISTEN=1` to stay in-process.
- OIDC links a sign-in to an existing local account only when the provider sends `email_verified === true`, and the link wipes that account's password, 2FA, passkeys and sessions (pre-registration takeover).
