# server/

| File | Role |
|---|---|
| `index.js` | Express app: security headers, CSRF gate, all non-auth routes, static/vendor serving, error handler |
| `auth.js` | Sessions, scrypt passwords, local auth routes, OIDC (code + PKCE), rate limiter, `httpError` |
| `db.js` | Async adapter `db.all/get/run/exec` over `node:sqlite` or `pg`; append-only `migrations`; `getSetting`/`setSetting` |
| `srs.js` | FSRS-inspired `schedule(prev, rating, now)` and `weakFirst` sort |
| `core.test.js` | Unit tests for srs + `public/lib.js` |

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

- Session cookie: `flipp_session` (HttpOnly, SameSite=Lax, Secure when `PUBLIC_URL` is https). The DB stores only `HMAC(JWT_SECRET, token)`.
- Setup is atomic: the first `INSERT` into `settings('setup_done')` wins.
- OIDC links a sign-in to an existing local account only when the provider sends `email_verified === true`.
