-- 0019_availability_owner.sql
-- Gives `availability` the owner column 0008 deliberately omitted.
--
-- 0008's header said it plainly: "No owner/user_id column. This is a 1:1
-- tutor-student CRM with exactly one 'elle' account [...] Every row in this
-- table implicitly belongs to 'the' elle account. [...] If this app is ever
-- extended to support more than one tutor, that is a project-wide change (new
-- FK on this table, plus role/authorization changes throughout), not
-- something to half-anticipate now."
--
-- This is that change. The reasoning in 0008 was correct for its time; it is
-- simply no longer the world the app lives in.
--
-- ENGINE NOTE: MariaDB 11.8 in production -- one ALTER per statement. See
-- migrations/README.md.
--
-- LIVE DATA WARNING: this table holds Elle's real recurring teaching
-- schedule. An earlier draft of this migration ended with
--     DELETE FROM availability WHERE admin_id IS NULL;
-- as a "defensive no-op on a fresh install". That is unacceptable here: if
-- the backfill below failed to resolve an admin for any reason, that
-- statement would silently destroy a real teaching schedule with no rollback
-- (MariaDB DDL is not transactional and this runner is forward-only). It has
-- been removed. Instead the precondition is checked BEFORE this file runs, by
-- 0018_guard_availability_has_admin.sql, which aborts the migration run
-- without touching a single row or column if any window cannot resolve an
-- owner.
--
-- Design notes:
--   - admin_id is the ONLY tenancy column this table gets -- no org_id. An
--     availability window is one specific teacher's weekly schedule; it is
--     meaningless at the org level, and org_id would be derivable from the
--     admin anyway. Every read of this table (computeOpenSlots) is
--     per-teacher once bookings are per-teacher, so admin_id alone serves
--     every query. This is the one table where denormalizing org_id would
--     buy nothing.
--   - ON DELETE CASCADE, unlike users.admin_id's SET NULL. The distinction is
--     deliberate: orphaning a student is recoverable (an owner reassigns
--     them), but an ownerless availability row is pure garbage that would
--     silently widen every remaining teacher's open slots if it leaked into
--     computeOpenSlots. Deleting a teacher deletes their schedule.
--   - idx_availability_day_of_week (0008) is superseded and dropped. Every
--     read is now "this admin's windows for this weekday", never "everyone's
--     windows for this weekday", so a day_of_week-leading index can no longer
--     serve any query. Dropping an index is not data loss.

-- --- add the column, nullable so the ALTER cannot fail on existing rows ----
ALTER TABLE availability
  ADD COLUMN admin_id BIGINT UNSIGNED NULL AFTER id;

-- --- backfill to the single pre-existing admin -----------------------------
-- Under the old single-teacher model every row belonged to the one 'elle'
-- account, which 0017 has just renamed to role='admin'. MIN(id) makes the
-- choice deterministic if more than one admin somehow exists. The nested
-- SELECT is required because a subquery in an UPDATE cannot read the table
-- being updated directly, only a derived table built from it.
UPDATE availability
   SET admin_id = (
         SELECT id FROM (
           SELECT MIN(id) AS id FROM users WHERE role = 'admin' AND org_id = 1
         ) AS one_admin
       )
 WHERE admin_id IS NULL;

-- --- tighten to NOT NULL ---------------------------------------------------
-- Safe to run only because 0018_guard_availability_has_admin.sql already
-- proved, BEFORE this file altered anything, that every row can resolve an
-- admin. That check deliberately lives in its own migration: MariaDB DDL is
-- not transactional and this runner is forward-only, so a guard placed here
-- would abort with the ADD COLUMN above already applied, and the retry would
-- fail on "Duplicate column name". Keeping the check in a file that mutates
-- nothing means a failure leaves this table completely untouched.
ALTER TABLE availability
  MODIFY COLUMN admin_id BIGINT UNSIGNED NOT NULL;

-- --- indexes ---------------------------------------------------------------
-- Serves the only query this table is read by under the new model: "this
-- admin's windows for this weekday", inside computeOpenSlots. Its leading
-- column also satisfies InnoDB's FK-indexing requirement for
-- fk_availability_admin_id below.
ALTER TABLE availability
  ADD KEY idx_availability_admin_id_day_of_week (admin_id, day_of_week);

ALTER TABLE availability
  DROP INDEX idx_availability_day_of_week;

-- --- foreign key -----------------------------------------------------------
ALTER TABLE availability
  ADD CONSTRAINT fk_availability_admin_id
    FOREIGN KEY (admin_id) REFERENCES users (id)
    ON DELETE CASCADE;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE availability DROP FOREIGN KEY fk_availability_admin_id;
-- ALTER TABLE availability ADD KEY idx_availability_day_of_week (day_of_week);
-- ALTER TABLE availability DROP INDEX idx_availability_admin_id_day_of_week;
-- ALTER TABLE availability DROP COLUMN admin_id;
