# elle_b — Student CRM API

Node/Express + MySQL. Serves `elle_f` only. Deployed behind Caddy on a VPS.

## Run

```sh
npm run local     # docker MySQL (3307) + nodemon, ENV_FILE=.env.dev
npm run dev       # nodemon against .env — which points at PRODUCTION
npm test          # node --test, test/**/*.test.js
```

`npm run dev` and `npm start` read `.env`, and `.env` points at production.
Use `npm run local` for local work. Same reasoning applies to `seed-dev.js`,
which refuses to fall back to `.env`.

Port is 4001. If it's held, `npm run port:free` — `dev` and `local` already
run it via their pre-scripts.

## Layout

- `src/routes/*.route.js` — one file per resource, mounted in `src/app.js`
- `src/routes/*.helpers.js` — query/shape logic for that route, same basename
- `src/middleware/` — auth, validate, upload, rateLimit
- `src/db/pool.js` — the only MySQL pool; never create another
- `src/services/s3.js` — S3 access
- `migrations/` — numbered `.sql`, applied by `npm run migrate`

Route files stay thin: validate, authorize, delegate to helpers. A route
growing its own SQL is a sign it belongs in the matching `.helpers.js`.

## Authorization — read `src/middleware/auth.js` before choosing a gate

Four gates, not interchangeable. Picking the wrong one leaks student data:

- `requireAuth()` — authenticated, any role
- `requireRole(...roles)` — exact allowlist, ignores seniority
- `requireMinRank(role)` — **administrative actions only**
- `requireCapability(set)` — the **only** gate allowed to guard an individual
  student's records

`manager` outranks `admin` by rank but must see strictly less student data, so
`requireMinRank` is never correct for per-student access. Capability sets live
in `src/constants/roles.js`.

Every new route needs an explicit gate. There is no default-deny.

## Conventions

- CommonJS (`require`), not ESM
- Error responses: `{ status: 'error', message }`
- Validation via `middleware/validate.js` + `src/schemas/`
- Tests use the real test DB; don't mock MySQL

## Don't

- Don't commit `.env`, `keys/`, or any `.pem`
- Don't write a migration that can't roll back
- Don't add a dependency without asking
