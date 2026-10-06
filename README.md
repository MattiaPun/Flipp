# Flipp

> [!WARNING]
> **Yes, this project is vibe coded. I know. I don't care: I built it for fun.**
>
> Flipp was written mostly by an AI coding assistant (Claude), with me steering, testing and clicking around. It works well for me. It has tests, and I tried to follow sensible security practice.
>
> But it is a hobby project, **not** a professionally audited product:
> - **No guarantees, no SLA, no roadmap promises.** Bugs may exist, and features may change or break.
> - **Run it at your own risk.** Keep backups of `./data`.
> - If you put it on the public internet, put it behind a reverse proxy with TLS and finish the setup wizard immediately.
>
> If Flipp ever gains real traction, and enough people want a proper, non-vibe-coded version, I'll build one. Star the repo or open an issue to let me know.
>
> Issues and PRs are welcome. I'll look at them when I feel like it. 🙂

Flipp is a minimal flashcard app with spaced repetition that you host yourself. It runs as one container and keeps its data in one folder.

- **Courses → Sets → Cards.** Cards support Markdown, code, LaTeX (`$x^2$`, `$$…$$`), images and text-to-speech.
- **Study modes**
  - **Learn**: FSRS-style spaced repetition.
  - **Flashcards**: 3D flip, with swipe left/right.
  - **Write**: you type the answer, and small typos and missing accents are accepted.
  - **Match**: a timed matching grid with a leaderboard.
- **Weak cards come back.** A card you rate *Again* or *Hard* returns 3–5 cards later. It leaves the session only after you answer it correctly twice. Cards with many lapses and low stability come first in the queue.
- **Accounts**
  - Local accounts, with a setup wizard on first run.
  - Invite links.
  - OpenID Connect (Authentik, Authelia, Keycloak, Google, …).
  - Two roles: Admin and User.
- **Installable PWA** for iOS, iPadOS and Android, with safe-area support and an offline app shell. Keyboard shortcuts: `Space` flips, `1`–`4` or `←`/`→` rates, `Z` undoes.

## Quick start

```bash
cp .env.example .env        # set JWT_SECRET and PUBLIC_URL at minimum
docker compose up -d --build
```

Open http://localhost:3000.

To skip the local build, use the prebuilt multi-arch image (amd64/arm64): in `docker-compose.yml`, replace `build: .` with `image: ghcr.io/mattiapun/flipp:latest`, then run `docker compose pull && docker compose up -d`.

Everything is stored in `./data`:

- `Flipp.db`: the SQLite database, in WAL mode
- `uploads/`: card images

To back up, copy that folder. For a consistent copy, stop the container first or use `sqlite3 Flipp.db ".backup backup.db"`.

### Initial admin account

On first boot there is no administrator, so Flipp shows a **setup wizard**. The first person to open the site creates the admin account.

- **Finish setup before exposing the instance publicly.** Until setup is done, anyone who reaches the site can become admin.
- If OIDC is configured, the first SSO sign-in can complete setup instead and becomes the admin.

After setup, the **Admin** page lets you:

- turn public sign-ups on or off (`ALLOW_REGISTRATION` sets the default)
- create invite links, valid for 7 days and usable once
- add users directly with a temporary password
- promote or demote users, and delete them

Only admins can make a course **Public**. A public course is visible to every user, and each user keeps their own progress in it. All other courses are private to their owner.

## Configuration

All settings are environment variables. See [.env.example](.env.example) for the full list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | (derived from request) | External URL. Used for the OIDC redirect URI, the CSRF origin check and the `Secure` cookie flag. |
| `DATABASE_URL` | empty (SQLite at `/data/Flipp.db`) | Set `postgres://user:pass@host:5432/flipp` to use PostgreSQL |
| `JWT_SECRET` | auto-generated | Server secret. Generate with `openssl rand -hex 32`. |
| `ALLOW_REGISTRATION` | `true` | Default for public sign-up. Admins can change it at runtime. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES` | — | Enable SSO |
| `OIDC_NAME` | `SSO` | Label on the login button |
| `OIDC_TOKEN_AUTH_METHOD` | `client_secret_basic` | Or `client_secret_post` |
| `OIDC_ALLOW_SIGNUP` | `true` | Create accounts for new SSO users |
| `OIDC_ADMIN_GROUP` | — | Members of this `groups` claim value become admins |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Express trust-proxy setting |
| `NEW_CARDS_PER_SESSION` | `20` | Maximum new cards per Learn session |

### OpenID Connect

Create an OAuth2/OIDC client at your identity provider:

- **Type**: confidential, authorization-code flow (Flipp uses PKCE)
- **Redirect URI**: `https://<your PUBLIC_URL>/api/auth/oidc/callback`
- **Scopes**: `openid email profile`. Add `groups` if you use `OIDC_ADMIN_GROUP` and your provider needs it.

Then set `OIDC_ISSUER` to the issuer URL. Flipp reads `/.well-known/openid-configuration` from that URL. Examples:

| Provider | `OIDC_ISSUER` |
|---|---|
| Authentik | `https://auth.example.com/application/o/flipp/` |
| Authelia | `https://auth.example.com` |
| Keycloak | `https://kc.example.com/realms/<realm>` |
| Google | `https://accounts.google.com` |

How SSO users are matched to accounts:

1. If an SSO identity has been seen before, Flipp signs in its existing account.
2. If the provider marks the email as **verified** and it matches an existing local account, Flipp links the two.
3. Otherwise Flipp creates a new account, unless `OIDC_ALLOW_SIGNUP=false`.

To make SSO the only way new users can join, set `ALLOW_REGISTRATION=false`.

## Reverse proxy

Flipp serves plain HTTP on port 3000. Terminate TLS at your reverse proxy, and set `PUBLIC_URL` to the external `https://` URL. When `PUBLIC_URL` uses https, session cookies get the `Secure` flag, and the CSRF origin check compares against this URL. The proxy must pass the `Host` and `X-Forwarded-Proto` headers.

**Caddy**

```caddy
flipp.example.com {
  reverse_proxy flipp:3000
}
```

**nginx**

```nginx
server {
  listen 443 ssl http2;
  server_name flipp.example.com;
  client_max_body_size 10m;          # image uploads (8 MB max)
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

**Traefik** (labels on the `flipp` service)

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

- **Sessions.** The session token is a random 256-bit value. The browser keeps it in an `HttpOnly`, `SameSite=Lax` cookie, which is also `Secure` behind https. The database stores only an HMAC of the token, and sessions expire after 30 days.
- **Passwords** are hashed with scrypt.
- **CSRF.** No CORS headers are sent. Every state-changing request must come from the same origin and carry the custom `X-Flipp` header.
- **Content Security Policy.** Scripts load only from the app itself (`script-src 'self'`): no inline scripts and no CDNs. Framing is denied.
- **XSS.** Card content is stored as entered. When it is displayed, it is rendered as Markdown and then sanitized with DOMPurify.
- **Uploads.** Flipp checks each file's magic bytes and accepts only PNG, JPEG, GIF and WebP. SVG is rejected. Files get random names.
- **Rate limits.** Login, registration, setup and SSO allow 10 requests per minute per IP. Uploads allow 60 per minute.
- **SQL.** All queries are parameterized.

## Development

```bash
npm install
npm run dev     # http://localhost:3000, data in ./data
npm test        # scheduler, session queue, fuzzy grading, CSV import/export
```

Requires Node 22.13 or newer, for the built-in `node:sqlite` module.

There is no build step. The browser loads ES modules directly, using Preact and htm, marked, DOMPurify and KaTeX served from `node_modules`.

```
server/  index.js (routes, security headers), auth.js (sessions, local + OIDC), db.js (SQLite/Postgres + migrations), srs.js (scheduler)
public/  app.js (pages), study.js (study modes), lib.js (shared logic), ui.js, md.js, sw.js, styles.css
```

To change the database schema, add a new entry to the `migrations` array in `server/db.js`. Never edit an entry that has already shipped.

## License

[GNU GPL v3](LICENSE). You may use, modify and share Flipp, including commercially, under these conditions:

- If you distribute it, modified or not, you must distribute the full source code.
- Your distributed version must stay under GPL v3.
- You must keep the copyright and license notices.
