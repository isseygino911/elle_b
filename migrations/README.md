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
Note that MariaDB DDL is **not transactional**: a migration that fails
halfway leaves the schema partly changed, with no rollback. Take a verified
backup before applying anything to production.

## ⚠️ The database engine is MariaDB, not MySQL

**Production runs MariaDB 11.8** (Hostinger-managed). Local dev runs
`mariadb:11.8` via `docker-compose.dev.yml` to match.

Migrations `0001`–`0011` say "MySQL 8" throughout and were authored against
that assumption, because local dev used to run the `mysql:8.0` image. It was
never true of production. This was discovered — not introduced — while
applying `0012_survey_responses_per_student.sql`, whose header records the
`SELECT VERSION()` that revealed it. Those older headers are left as-is
(they're applied history and must not be edited), but **do not trust them
for engine semantics.**

**Write every migration to the intersection of both engines:**

| Feature | MySQL 8 | MariaDB 11.8 | Rule here |
|---|---|---|---|
| Stored generated column | `STORED` | `PERSISTENT` | Use `PERSISTENT` |
| Index on a `VIRTUAL` column | allowed | **rejected** | Never index a `VIRTUAL` column |
| Batched multi-clause `ALTER` | fine | **errno 121** | One `ALTER` per statement |

The last two are not theoretical. `0009_create_bookings.sql` declared
`UNIQUE` on a `VIRTUAL` generated column — valid MySQL 8, invalid MariaDB —
so that index may not exist in production at all. `0012` hit errno 121 on a
batched `ALTER` and had to be split into separate statements.

Do NOT add `ENCRYPTION='Y'` to new `CREATE TABLE` statements. This project's
current production host does not have the keyring plugin configured, so
InnoDB tablespace encryption is not available there — specifying
`ENCRYPTION='Y'` would either fail outright or be silently unsupported, and
`innodb_file_per_table` alone does not encrypt data at rest. All existing domain tables (`users`, `invitations`,
`surveys`, `survey_questions`, `videos`, `comments`) had this rationale
removed for the same reason — see their migration file headers. If the
hosting situation changes to a host that supports the keyring plugin, this
decision should be revisited as a single project-wide change (e.g. a
dedicated migration/ops effort covering all tables), not decided ad hoc on a
per-table basis in individual future migrations.

## Precondition guards (`NNNN_guard_*.sql`)

Some migrations depend on data being in a resolvable state — e.g. `0019`
backfills `availability.admin_id` from the org's admin, and cannot proceed if
no admin exists. Those checks live in their **own migration file**, numbered
immediately before the migration they protect:

| Guard | Protects |
|---|---|
| `0018_guard_availability_has_admin.sql` | `0019_availability_owner.sql` |
| `0020_guard_bookings_have_admin.sql` | `0021_bookings_multi_tenant.sql` |
| `0022_guard_messages_have_admin.sql` | `0023_content_multi_tenant.sql` |

**A guard file must never change schema or data.** It either succeeds silently
or aborts the run.

This separation is not stylistic. MariaDB DDL is not transactional and this
runner is forward-only, so a check placed *inside* a mutating migration aborts
with earlier statements already applied — leaving a half-migrated table that
cannot be re-run. This was observed directly: an in-file guard correctly
stopped the content migration, but only after adding `org_id` to five tables,
and the retry failed with `ERROR 1060 Duplicate column name 'org_id'`. Keeping
the check in a file that mutates nothing means the recovery path is simply
*fix the data, re-run `npm run migrate`*.

`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` would also make migrations
re-runnable, but is **MariaDB-only** — MySQL 8 rejects it as a syntax error
(verified). It is therefore not used; see the engine section above.

### The guard idiom

```sql
SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',STRICT_ALL_TABLES');
CREATE TEMPORARY TABLE _guard_NNNN (
  ABORT_describes_the_problem_here INT NOT NULL
);
INSERT INTO _guard_NNNN (ABORT_describes_the_problem_here)
SELECT NULL FROM <table> WHERE <row cannot be resolved>;
DROP TEMPORARY TABLE _guard_NNNN;
```

Zero bad rows inserts nothing and the run continues. One or more aborts with
`ERROR 1048: Column 'ABORT_describes_the_problem_here' cannot be null` — so
**name the column after the problem**, since that name is the error message.
STRICT mode is set explicitly because without it the NULL insert is only a
warning.

Three alternatives were tested against MariaDB 11.8 and rejected:
`SIGNAL SQLSTATE` (only valid inside a stored program, not a bare script
statement); `SELECT CASE ... ELSE (SELECT undefined_column)` (the column is
resolved at *parse* time, so it aborts even when nothing is wrong); and
`IF(cond, 1, (SELECT 1 ... WHERE 1/0))` (silently returns NULL instead of
erroring — it would let the run proceed past bad rows, the worst outcome).

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
