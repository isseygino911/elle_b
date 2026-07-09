# Deploy Instructions — API (server)

These are instructions for whoever has actual VPS access. No deployment has
been executed from this environment — this repo currently has no live server
access or SSH credentials. The steps below describe what to run, not a
record of something already done.

This repo (`elle_b`) is the API only. The client lives in a separate repo
(`elle_f` — `https://github.com/isseygino911/elle_f.git`), cloned
independently on the VPS; see that repo's own `DEPLOY.md` for the client
build/serve steps. This repo's `Caddyfile` fronts both, since Caddy is
shared VPS-level config.

Domains (real, assigned):
- Frontend: `elle.isseylab.com` (static SPA build from the client repo, served by Caddy)
- API: `api.isseylab.com` (reverse-proxied by Caddy to this Express server)

They're split onto separate subdomains rather than one domain with an
`/api/*` path prefix — see `Caddyfile` for the two site blocks. The client's
`VITE_API_BASE_URL` is the single place that needs to know the API's
origin; everything else (CORS, cookies) already supports cross-origin
between same-registrable-domain subdomains.

Git remote: `origin` -> `https://github.com/isseygino911/elle_b.git`.

## 1. Local development

1. Copy `.env.example` to `.env` in this directory and fill in real local
   values, including `DB_ROOT_PASSWORD`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`,
   `DB_PORT`. `.env` is the single source of truth for these vars.
   `docker-compose.dev.yml` reads them via the `--env-file` flag baked into
   the `npm run db:up` / `npm run db:down` scripts (see the comment header
   in `docker-compose.dev.yml` for the raw `docker compose` command
   equivalent).
2. Start local MySQL:
   ```
   npm run db:up
   ```
   (equivalent to `docker compose --env-file ./.env -f docker-compose.dev.yml up -d`)
3. Run database migrations:
   ```
   npm run migrate
   ```
4. Start the API:
   ```
   npm run dev
   ```
   (run the client's own `npm run dev` from the client repo in a separate
   terminal.)
5. Stop MySQL when done:
   ```
   npm run db:down
   ```

## 2. Running database migrations

Migrations live in `migrations/` and run via `package.json`'s `migrate`
script (`node migrations/run.js`), invoked as `npm run migrate`. Requires
`.env` to have valid `DB_*` values pointing at a running MySQL instance
(local docker-compose or the VPS's native MySQL).

## 3. Production deploy (VPS — requires actual SSH access, not available here)

The API deploys as a Docker container (`Dockerfile` +
`docker-compose.prod.yml`). MySQL and Caddy both remain native installs on
the VPS. `ecosystem.config.js` (PM2) is left in the repo as a non-Docker
fallback but is no longer the primary path.

1. Pull this repo to the VPS: `git pull origin main`.
2. Ensure `.env` on the VPS has real production values for every var listed
   in `.env.example` (real secrets — never copied from this repo), in
   particular `CORS_ORIGIN=https://elle.isseylab.com`, `NODE_ENV=production`
   (makes the refresh-token cookie `Secure`, required over HTTPS), and
   `DB_HOST=localhost` (the container uses host networking — see the
   comment header in `docker-compose.prod.yml` — so `localhost` correctly
   reaches the VPS's native MySQL from inside the container).
3. Confirm `keys/jwt_private.pem` / `jwt_public.pem` already exist on the
   VPS (generated once per `.env.example`'s instructions) — they're mounted
   read-only into the container, never baked into the image.
4. Build and start the API container:
   ```
   docker compose -f docker-compose.prod.yml up -d --build
   ```
   Check it came up clean: `docker compose -f docker-compose.prod.yml logs -f`
   (expect `Server listening on port 4000`, then Ctrl+C to stop following).
5. Separately, pull/build the client repo (`elle_f`) — see its own
   `DEPLOY.md`. It needs `VITE_API_BASE_URL=https://api.isseylab.com` set
   before its build step.
6. Copy `Caddyfile` (from this repo) to the VPS's Caddy config location,
   filling in the real absolute path to the client repo's `dist/` (see the
   comment in `Caddyfile`) and ensuring the `{$PORT}` env var (or a
   hardcoded port) matches this repo's `.env`'s `PORT`. Reload Caddy:
   ```
   caddy reload --config /path/to/Caddyfile
   ```
   (or `systemctl reload caddy`, depending on how Caddy is installed on the
   VPS — follow whatever the existing VPS setup uses, per project instructions
   not to invent a new proxy topology.)
7. DNS: point both `elle.isseylab.com` and `api.isseylab.com` A/AAAA records
   at the VPS's IP before reloading Caddy, or the automatic HTTPS cert
   issuance will fail.
8. Verify: hit `https://api.isseylab.com/api/health` (should reach Express)
   and `https://elle.isseylab.com/` (should serve the React app and
   successfully call the API cross-subdomain — check the browser network
   tab for CORS/cookie errors on login).

Redeploying after an API code change: `git pull origin main`, then
`docker compose -f docker-compose.prod.yml up -d --build` again — no Caddy
reload needed unless `Caddyfile` itself changed.

## Bootstrapping the first 'elle' account

The app's registration flow (`src/routes/auth.route.js` /
`invitations.route.js`) only ever creates `student` accounts via invitation
redemption — there's no in-app way to create the first `elle` (teacher/admin)
account. `scripts/seed-elle.js` is a one-off script for that: it hashes the
password with the same argon2id scheme the app uses and inserts a
`role='elle'` row directly.

From this repo's root:
```
npm run seed:elle -- <email> <password> [name]
```
(or `node scripts/seed-elle.js <email> <password> [name]` directly). Requires
`.env` with valid `DB_*` values, same as migrations.

This has already been run once against the live database. Do not re-run it
for that same email — it will exit with a duplicate-email error, not update
the existing account. Running it again with a different email (to create
another elle account) is fine.

## Env vars / secrets required (placeholders only — see `.env.example`)

All names below already exist in `.env.example`; nothing new was invented here.

- `DB_ROOT_PASSWORD` — placeholder, used only by `docker-compose.dev.yml` locally.
- `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` — MySQL connection.
- `PORT` — Express listen port, must match `Caddyfile`'s `{$PORT}` in production.
- `CORS_ORIGIN` — production client origin.
- `NODE_ENV` — set to `production` in `.env` on the VPS (read into the
  container via `docker-compose.prod.yml`'s `env_file`).
- JWT / Jitsi vars — see `.env.example`.
- AWS S3 vars (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_S3_BUCKET`) — survey upload/download. See `infra/S3_SETUP.md` for the
  manual bucket/IAM provisioning steps (not executed from this environment)
  and `infra/s3-bucket-policy.json` / `infra/s3-iam-policy.json` for the
  config to apply.

No real credentials appear anywhere in this file or in any file created for
this task.
