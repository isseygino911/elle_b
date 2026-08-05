-- 0018_guard_availability_has_admin.sql
-- PRECONDITION GUARD for 0019_availability_owner.sql. Changes no schema and
-- no data: it either succeeds silently or aborts the migration run.
--
-- WHY THIS IS ITS OWN FILE
-- MariaDB DDL is not transactional and this project's runner is forward-only
-- with no rollback. When a guard lived inside the migration that mutates the
-- schema, a guard failure left the table half-altered -- columns added, but
-- the run stopped before the NOT NULL tightening. Fixing the underlying data
-- and re-running then failed with "Duplicate column name", because the
-- earlier ADD COLUMN had already applied. That turned a safe stop into a
-- manual cleanup job on a production database.
--
-- Observed directly: an in-file guard in an earlier draft aborted
-- 0020_content_multi_tenant correctly, but left org_id on surveys,
-- survey_questions, survey_answers, videos and messages, and the retry failed
-- with ERROR 1060.
--
-- Splitting the check into a file that mutates NOTHING means a failure leaves
-- the schema completely untouched, so the recovery path is simply: fix the
-- data, re-run `npm run migrate`. No hand-cleaning, no partial state.
--
-- MySQL's `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` would also solve this,
-- but was rejected: it is MariaDB-only syntax and MySQL 8 rejects it outright
-- with a syntax error (verified against mysql:8.0). Every migration in this
-- project is written to the intersection of both engines -- see
-- migrations/README.md.
--
-- WHAT IT CHECKS
-- That every availability row can resolve an owning admin once 0019 runs.
-- 0019 backfills availability.admin_id from the single pre-existing admin in
-- org 1; if no such admin exists, every row would be left NULL and 0019's
-- `MODIFY ... NOT NULL` would fail with an opaque error -- or worse, invite a
-- future author to "fix" it with a DELETE against Elle's real teaching
-- schedule.
--
-- HOW IT WORKS
-- A temporary table with a single NOT NULL column, into which one NULL is
-- inserted per unresolved row. Zero unresolved rows inserts nothing and the
-- run continues. One or more aborts with:
--     ERROR 1048: Column 'ABORT_availability_rows_have_no_resolvable_admin'
--                 cannot be null
-- naming the problem in the error text itself. The temporary table is
-- session-scoped and leaves no schema residue.
--
-- STRICT mode is set explicitly rather than assumed from server config,
-- because without it the NULL insert is a warning rather than an error.
--
-- Alternatives tested against MariaDB 11.8 and rejected:
--   - SIGNAL SQLSTATE: only valid inside a stored program (procedure /
--     function / trigger), not as a bare statement in a migration script.
--   - SELECT CASE ... ELSE (SELECT undefined_column): MariaDB resolves the
--     column reference at PARSE time, so it aborted even when zero rows were
--     unresolved -- a false alarm blocking a valid migration.
--   - IF(cond, 1, (SELECT 1 FROM (SELECT 1) x WHERE 1/0)): silently returned
--     NULL instead of erroring, which would let the run proceed past
--     unresolved rows. The worst possible failure mode here.
--
-- IF THIS FIRES: do NOT delete rows. Work out which admin each availability
-- window belongs to and set users.role='admin' on the intended teacher (or
-- set availability.admin_id by hand), then re-run `npm run migrate`.

SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',STRICT_ALL_TABLES');

CREATE TEMPORARY TABLE _guard_0018 (
  ABORT_availability_rows_have_no_resolvable_admin INT NOT NULL
);

-- One NULL per availability row that 0019's backfill will not be able to
-- resolve. The condition mirrors 0019's backfill exactly: rows are resolvable
-- only if an admin exists in org 1 to attribute them to.
INSERT INTO _guard_0018 (ABORT_availability_rows_have_no_resolvable_admin)
SELECT NULL
  FROM availability
 WHERE NOT EXISTS (
         SELECT 1 FROM users WHERE role = 'admin' AND org_id = 1
       );

DROP TEMPORARY TABLE _guard_0018;
