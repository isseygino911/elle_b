# Database Migrations

Raw SQL migrations, no ORM. This directory is the only place schema changes
live.

(`server/scripts/seed-elle.js`, which bootstraps the first `elle` account,
is a one-off data-seeding script, not a schema migration — it doesn't live
here; see `DEPLOY.md` for its usage.)

## Naming convention

```
NNNN_description.sql
```

- `NNNN` — 4-digit, zero-padded sequence number (`0000`, `0001`, `0002`, ...).
- `description` — snake_case, short summary of what the migration does.

Example: `0001_create_users_table.sql`

Files are applied in filename-sorted order, so the sequence number controls
apply order. Never renumber or edit a migration file that has already been
applied anywhere (including just locally) — add a new file instead.

`0000_widen_schema_migrations_id.sql` is a deliberate, narrow exception to
this convention: it widens `schema_migrations.id` from `VARCHAR(20)` to
`VARCHAR(64)` because `0001_create_users_and_invitations` — the very first
domain migration's own bookkeeping id — is 33 characters, already past the
original limit. It is named `0000_...` rather than the next free sequence
number specifically so `fs.readdirSync().sort()` in `run.js` places it
before `0001_...` on a fresh install (lexical sort: `"0000_i" < "0000_w" <
"0001_"`), which a later-numbered fix could not do. Do not renumber this
file to "correct" it into normal sequence — doing so would reintroduce the
fresh-install failure this file exists to prevent.

## Adding a new migration

1. Create a new file `server/migrations/NNNN_description.sql`, where `NNNN`
   is the next unused sequence number.
2. Write plain SQL in it (`CREATE TABLE`, `ALTER TABLE`, etc.). Keep each
   migration file scoped to one logical change.
3. Do not edit or delete previously-applied migration files. If you need to
   change something already applied, write a new migration that alters it.

There is no rollback/down machinery — migrations are forward-only at this
project's scale. If a mistake ships, fix it with a follow-up migration.

Do NOT add `ENCRYPTION='Y'` to new `CREATE TABLE` statements. This project's
current production host (Hostinger-managed MySQL) does not have the keyring
plugin configured, so InnoDB tablespace encryption is not available there —
specifying `ENCRYPTION='Y'` would either fail outright or be silently
unsupported, and `innodb_file_per_table` (the MySQL 8 default) alone does not
encrypt data at rest. All existing domain tables (`users`, `invitations`,
`surveys`, `survey_questions`, `videos`, `comments`) had this rationale
removed for the same reason — see their migration file headers. If the
hosting situation changes to a host that supports the keyring plugin, this
decision should be revisited as a single project-wide change (e.g. a
dedicated migration/ops effort covering all tables), not decided ad hoc on a
per-table basis in individual future migrations.

## Running migrations

From `server/`:

```
npm run migrate
```

This runs `node migrations/run.js`, which:

1. Ensures the `schema_migrations` bookkeeping table exists.
2. Reads all `*.sql` files in this directory, sorted by filename.
3. Skips any file already recorded as applied in `schema_migrations`.
4. Runs each new file's SQL, then records it as applied (row `id` =
   filename minus `.sql`).
5. Exits `0` on success, or `1` with the error printed on failure.

Connection info is read from environment variables (`DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD`) via `dotenv`, loaded from `server/.env`.
See the repo root `.env.example` for the documented variable contract.

## Files in this directory

- `0000_init.sql` — creates the `schema_migrations` bookkeeping table only.
  This is Phase 0 scaffolding; no domain tables exist yet. Domain tables
  (users, invitations, etc.) start with `0001_...` in Phase 1.
- `run.js` — the migration runner script described above.
