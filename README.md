# Flipp

> [!WARNING]
> **Yes, this project is vibe coded. I know. I don't care: I built it for fun.**
>
> Flipp was written mostly by an AI coding assistant (Claude), with me steering, testing and clicking around. It works well for me. It has tests, and I tried to follow sensible security practice.
>
> But it is a hobby project, not a professionally audited product:
> - No guarantees, no SLA, no roadmap promises. Bugs may exist, and features may change or break.
> - Run it at your own risk. Keep backups of `./data`.
> - If you put it on the public internet, put it behind a reverse proxy with TLS and finish the setup wizard immediately.
>
> If Flipp ever gains real traction, and enough people want a proper, non-vibe-coded version, I'll build one. Star the repo or open an issue to let me know.
>
> Issues and PRs are welcome. I'll look at them when I feel like it. 🙂

Flipp is a minimal flashcard app with spaced repetition that you host yourself: a self-hosted, multi-user Anki alternative. It runs as one container and keeps everything in one folder.

## Features

### Studying

- Spaced repetition with FSRS-6 and Anki-style learning steps. The rating buttons show the next interval. An optional per-user optimizer fits the scheduler to your own review history.
- A card you rate Again or Hard comes back 3 to 5 cards later and leaves the session after two correct answers. Due cards with many lapses come first.
- Study modes: Learn (spaced repetition), Flashcards (flip or swipe), Write (tolerates typos and missing accents, with hints and a character diff), Multiple choice, and Cram (no scheduling).
- Card types: basic, basic with reverse, and cloze (`{{c1::answer::hint}}`). Cards can hold Markdown, code, LaTeX, images and audio, plus mnemonic, example and notes fields. Text-to-speech uses the browser's voices.
- Per-course settings for target retention, daily limits, learning steps and leech handling (suspend or tag cards you keep forgetting).
- Session length in cards or minutes, starred cards only, study direction, bury and suspend.
- Streaks. Every 7 days of streak earns a streak freeze (you can hold 2), which covers a missed day.
- Statistics: heatmap, 30-day forecast, retention and hardest cards.
- Daily push reminders, and offline study that syncs when you're back online.

### Content

- Courses contain sets, sets contain cards. The editor has a formatting toolbar and live preview, and you can paste or drop images.
- Import from Quizlet, TSV or CSV, Anki `.apkg` (with media and review history) and Flipp course exports. Export a set as CSV or a whole course as an archive.
- Duplicate detection, bulk actions (move, copy, tag, star, suspend, delete), drag to reorder, tags, and ⌘K search.

### Sharing

- Share a course with specific people as viewers or co-editors.
- Put a course in the library to share it with everyone on the instance. Other users can add it to their courses or make their own copy.

### Accounts

- Local accounts, invite links, OpenID Connect (Authentik, Authelia, Keycloak, Google and others), passkeys, and authenticator-app 2FA with recovery codes.
- Password reset and email confirmation over SMTP.
- Two roles, user and admin. Admins can require 2FA for all admins.
- A list of signed-in devices with remote sign-out, a full export of your data, and account deletion.

### Administration

- Manage users, roles, sign-ups and invites, and read the audit log.
- Back up the database and uploads to one `.tar.gz`, by hand or on a schedule, and restore from it. Backups move between SQLite and PostgreSQL.
- Unused uploads are cleaned up every night.

### App

- Installable as a PWA on iOS, iPadOS and Android, with dark and light themes.
- Keyboard: `Space` flips, `1` to `4` or the arrow keys rate, `Z` undoes, `⌘K` searches.

## Quick start

```bash
cp .env.example .env        # set JWT_SECRET and PUBLIC_URL at minimum
docker compose up -d --build
docker compose logs flipp   # shows the one-time setup link
```

Open the setup link from the logs (`…/#/setup?token=…`) and create the admin account.

To skip the local build, use the prebuilt multi-arch image (amd64/arm64): in `docker-compose.yml`, replace `build: .` with `image: ghcr.io/mattiapun/flipp:latest`, then run `docker compose pull && docker compose up -d`.

Everything is stored in `./data`:

- `Flipp.db`: the SQLite database, in WAL mode
- `uploads/`: card images and audio
- `backups/`: backups made from the Admin page or on a schedule

### Initial admin account

On first boot there is no administrator. Flipp prints a setup token to the logs (or uses `SETUP_TOKEN` if you set it), and only someone with that token can create the admin account. With OIDC configured, an SSO sign-in that carries the token can complete setup instead.

After setup, the Admin page lets you manage users and roles, sign-ups and invites, storage, backups and the audit log.

Users create, study and share their own courses. Admins can also edit any course and manage the instance.

## Demo data

To try Flipp with sample content, run the seed script after the setup wizard:

```bash
docker compose exec -u node flipp node --disable-warning=ExperimentalWarning server/seed.js   # or: npm run seed
```

This adds 12 courses (including a very easy *Swedish for beginners*), a shared library, and 60 days of review history for your admin account. It also creates 8 demo users with `@demo.flipp.test` emails and the password `demo1234`. Run it again with `--reset` to recreate the demo data; your own data is never touched. Don't run it on an instance real people use.

## Configuration

All settings are environment variables. See [.env.example](.env.example) for the full list with comments.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | (derived from request) | External URL. Used for OIDC, passkeys, email links, the CSRF origin check and the `Secure` cookie flag. |
| `TZ` | `UTC` | Instance time zone for daily jobs and scheduled backups |
| `DATABASE_URL` | empty (SQLite at `/data/Flipp.db`) | Set `postgres://user:pass@host:5432/flipp` to use PostgreSQL |
| `JWT_SECRET` | auto-generated | Server secret; also encrypts stored 2FA secrets. Generate with `openssl rand -hex 32`. |
| `SETUP_TOKEN` | auto-generated, printed in logs | Token required to create the first admin |
| `ALLOW_REGISTRATION` | `true` | Default for public sign-up. Admins can change it at runtime. |
| `SMTP_URL`, `MAIL_FROM` | none | Enable password reset, emailed invites and email confirmation |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES` | none | Enable SSO |
| `OIDC_NAME` | `SSO` | Label on the login button |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` | Or `client_secret_post` |
| `OIDC_ALLOW_SIGNUP` | `true` | Create accounts for new SSO users |
| `OIDC_ADMIN_GROUP` | none | Members of this `groups` claim value become admins |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Express trust-proxy setting |
| `AUDIT_RETENTION_DAYS` | `365` | How long audit entries are kept |
| `MAX_IMPORT_MB`, `MAX_RESTORE_MB` | `300`, `4096` | Upload limits for imports and backup restores |

### OpenID Connect

Create an OAuth2/OIDC client at your identity provider:

- Type: confidential, authorization-code flow (Flipp uses PKCE)
- Redirect URI: `https://<your PUBLIC_URL>/api/auth/oidc/callback`
- Scopes: `openid email profile`. Add `groups` if you use `OIDC_ADMIN_GROUP` and your provider needs it.

Then set `OIDC_ISSUER` to the issuer URL. Flipp reads `/.well-known/openid-configuration` from that URL. Examples:

| Provider | `OIDC_ISSUER` |
|---|---|
| Authentik | `https://auth.example.com/application/o/flipp/` |
| Authelia | `https://auth.example.com` |
| Keycloak | `https://kc.example.com/realms/<realm>` |
| Google | `https://accounts.google.com` |

How SSO users are matched to accounts:

1. If an SSO identity has been seen before, Flipp signs in its existing account.
2. If the provider marks the email as verified and it matches an existing local account, Flipp links the two.
3. Otherwise Flipp creates a new account, unless `OIDC_ALLOW_SIGNUP=false`.

To make SSO the only way new users can join, set `ALLOW_REGISTRATION=false`. SSO users are exempt from the "require 2FA for admins" setting, since their identity provider handles that.

### Passkeys and push reminders

Both need HTTPS (except on `localhost`) and a correct `PUBLIC_URL`: passkeys are bound to its host name, so changing the domain later invalidates registered passkeys. On iPhone and iPad, push reminders work only after adding Flipp to the home screen (iOS 16.4+).

### Backups

Admin → Backups creates a `.tar.gz` with every table and every uploaded file, and can run daily at a chosen hour, keeping the newest N. Restoring replaces everything on the instance, signs everyone out, and restarts the server (the compose file's restart policy brings it back). Keep the same `JWT_SECRET` when restoring on another server, or two-factor secrets can't be decrypted. A backup can only be restored by a Flipp version with the same database schema.

For off-site copies, mount `/data/backups` elsewhere or sync it with your usual backup tool.

## Reverse proxy

Flipp serves plain HTTP on port 3000. Terminate TLS at your reverse proxy, and set `PUBLIC_URL` to the external `https://` URL. When `PUBLIC_URL` uses https, session cookies get the `Secure` flag, and the CSRF origin check compares against this URL. The proxy must pass the `Host` and `X-Forwarded-Proto` headers.

Caddy:

```caddy
flipp.example.com {
  reverse_proxy flipp:3000
}
```

nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name flipp.example.com;
  client_max_body_size 300m;         # Anki/course imports; raise to restore large backups
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Traefik, as labels on the `flipp` service:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.flipp.rule=Host(`flipp.example.com`)
  - traefik.http.routers.flipp.entrypoints=websecure
  - traefik.http.routers.flipp.tls.certresolver=letsencrypt
  - traefik.http.services.flipp.loadbalancer.server.port=3000
```

If your proxy is not on loopback or a private network, set `TRUST_PROXY` to its address. Rate limiting uses the client IP, so this matters.

## Security notes

- Sessions use a random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie, marked `Secure` behind https. The database stores only an HMAC of the token. Sessions last 30 days, are listed under Settings, and end when the password changes.
- Passwords are hashed with scrypt. 2FA secrets are encrypted with AES-256-GCM. TOTP codes can't be reused, and recovery codes are stored hashed and work once.
- Creating the first admin requires the setup token.
- No CORS headers are sent. State-changing requests must come from the same origin and carry an `X-Flipp` header.
- The Content Security Policy allows scripts only from the app itself (`script-src 'self'`), with no inline scripts or CDNs, and the app can't be framed.
- Card content is stored as entered and sanitized with DOMPurify when it is shown.
- Uploads are checked by their first bytes. Only PNG, JPEG, GIF and WebP images and WebM, Ogg, MP3, M4A and WAV audio are accepted. Files get random names.
- Requests for a course, set or card the user can't see return 404.
- Sign-in, registration, setup, 2FA, password reset and SSO are rate limited per IP.
- Sign-ins, failed sign-ins, security changes, admin actions, sharing and backups go to the audit log.
- All SQL queries are parameterized.

## Development

```bash
npm install
npm run dev        # http://localhost:3000, data in ./data
npm test           # unit + API + integration tests (SQLite)
TEST_DATABASE_URL=postgres://… npm test   # same API tests against PostgreSQL
npm run test:e2e   # browser tests (Playwright; run `npx playwright install chromium` once)
```

Requires Node 22.13 or newer, for the built-in `node:sqlite` module.

There is no build step. The browser loads ES modules directly, using Preact and htm, marked, DOMPurify, KaTeX and SimpleWebAuthn served from `node_modules`.

```
server/          index.js (app, security headers), auth.js (sessions, passwords), access.js (permissions), db.js (SQLite/Postgres + migrations),
                 backup.js, archive.js, optimizer.js, storage.js, jobs.js, routes/ (one file per area)
public/          app.js (router, shell, ⌘K), ui.js, lib.js + srs.js (shared with the server), md.js, offline.js, sw.js, pages/ (one file per screen)
test/            core (unit), api (end to end over HTTP), integrations (email, Anki, jobs, push), e2e/ (browser)
```

To change the database schema, add a new entry to the `migrations` array in `server/db.js`. Never edit an entry that has already shipped.

## License

[GNU GPL v3](LICENSE). You may use, modify and share Flipp, including commercially, under these conditions:

- If you distribute it, modified or not, you must distribute the full source code.
- Your distributed version must stay under GPL v3.
- You must keep the copyright and license notices.

The bundled Fraunces and Figtree fonts (`@fontsource-variable/fraunces`, `@fontsource-variable/figtree`) are separate works under the [SIL Open Font License 1.1](https://openfontlicense.org).
