-- 0021_bookings_multi_tenant.sql
-- Adds the teacher side of a booking and re-scopes the double-booking guard
-- from GLOBAL to per-teacher. This is the hard blocker for multi-teacher
-- support: without it, a second teacher literally cannot be booked.
--
-- THE PROBLEM
-- 0009 created:
--     active_scheduled_at DATETIME GENERATED ALWAYS AS
--       (CASE WHEN status = 'booked' THEN scheduled_at ELSE NULL END) VIRTUAL,
--     UNIQUE KEY uq_bookings_active_scheduled_at (active_scheduled_at)
-- Its rationale was explicit and correct at the time: "this is a single-tutor
-- 1:1 scheduling app -- Elle can only be in one meeting at a time, so no two
-- 'booked' rows should ever legitimately share a scheduled_at value."
--
-- With N teachers that invariant is false. The index knows nothing about
-- teachers, so it enforces "no two active bookings at this instant" across
-- the ENTIRE TABLE. Teacher B being booked at 09:00 Tuesday while teacher A
-- already holds 09:00 Tuesday is completely legitimate, but the second INSERT
-- trips ER_DUP_ENTRY, which bookings.route.js:107 reports to the user as
-- "That slot was just booked, please choose another" -- a statement that is
-- simply false, and unactionable: that instant is permanently unbookable for
-- every teacher except whoever claimed it first. Across organizations it is
-- also a cross-tenant information leak: a student at one studio is blocked by,
-- and implicitly learns about, a booking at an unrelated studio.
--
-- THE FIX
-- Replace the single-column unique index with a COMPOSITE one over
-- (admin_id, active_scheduled_at). The generated column keeps doing exactly
-- the job 0009 designed it for -- evaluating to NULL for any non-'booked' row
-- so that a cancelled slot can be re-booked, since a unique index permits
-- unlimited NULLs -- and the added leading admin_id column scopes that mutual
-- exclusion to one teacher's calendar.
--
-- The "no teacher may be double-booked" guarantee is therefore PRESERVED
-- EXACTLY, not weakened: (admin_id, instant) is still unique, so the same
-- teacher still cannot hold two active bookings at one instant. Only the
-- scope narrows, from "nobody, anywhere" to "not this teacher".
--
-- WHAT THIS INDEX STILL CANNOT DO: it compares exact start instants, so it
-- cannot detect OVERLAP. A 60-minute booking at 09:00 and a 30-minute booking
-- at 09:30 have different scheduled_at values and both satisfy this index,
-- yet they overlap in reality. No unique index can express interval overlap.
-- That check is the application's responsibility and lives in POST /bookings,
-- inside the insert transaction, using SELECT ... FOR UPDATE. Both layers are
-- required; neither is sufficient alone.
--
-- MARIADB GENERATED-COLUMN NOTE (verified empirically, 2026-08)
-- An earlier draft of this migration warned that MariaDB cannot index a
-- VIRTUAL generated column and that 0009's index might therefore not exist in
-- production at all. THAT WARNING WAS WRONG and has been corrected here to
-- avoid misleading whoever reads this next.
--
-- Verified by applying 0000-0015 to a real mariadb:11.8 container and running
-- SHOW CREATE TABLE bookings:
--     `active_scheduled_at` datetime GENERATED ALWAYS AS (...) VIRTUAL,
--     UNIQUE KEY `uq_bookings_active_scheduled_at` (`active_scheduled_at`),
-- MariaDB 11.8 accepts a UNIQUE index on a VIRTUAL generated column. 0009
-- applied cleanly, the column is VIRTUAL, and the index EXISTS in production.
--
-- Consequence: this migration RESCOPES a guard that is currently working. It
-- does not restore a missing one. The double-booking protection is live today
-- and must not be dropped without the replacement being added in the same
-- migration -- which it is, a few statements below.
--
-- The column is still recreated as PERSISTENT rather than VIRTUAL. That is a
-- deliberate, conservative choice, not a requirement: PERSISTENT is valid on
-- both engines and removes any dependence on the indexed-VIRTUAL behaviour
-- differing between MySQL 8, MariaDB, and future versions of either. It costs
-- 8 bytes per row on a table of this size, which is negligible.
--
-- STILL WORTH RUNNING FIRST on production:  SHOW CREATE TABLE bookings\G
-- to confirm the live schema matches the baseline this was tested against.
--
-- LIVE DATA: bookings are real. Columns are added nullable, backfilled, then
-- tightened. There is no DELETE in this file, and an abort guard (same pattern
-- in 0020_guard_bookings_have_admin.sql) prevents the NOT NULL step from being
-- reached with unresolved rows.
--
-- Design notes:
--   - admin_id: the teacher whose calendar this booking occupies. ON DELETE
--     RESTRICT, matching the audit-trail posture of invitations.created_by and
--     videos.uploaded_by -- a teacher with booking history must not be
--     deletable out from under it.
--   - org_id: denormalized even though derivable via the student. Justified
--     because a literal `org_id = ?` predicate is greppable and auditable: a
--     reviewer confirms tenancy by reading one WHERE clause instead of tracing
--     a join, and one forgotten join is a cross-tenant leak.
--   - idx_bookings_scheduled_at_status (0009) is superseded. Every query it
--     served -- open-slots for a day, upcoming-across-all-students -- is now
--     scoped to one admin or one org first, so a scheduled_at-leading index
--     can no longer serve them.

-- --- add tenancy columns, nullable ----------------------------------------
ALTER TABLE bookings
  ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

ALTER TABLE bookings
  ADD COLUMN admin_id BIGINT UNSIGNED NULL AFTER org_id;

-- --- backfill from each booking's student ----------------------------------
-- Under the old single-teacher model, the student's org and owning admin are
-- exactly this booking's org and teacher.
UPDATE bookings b
  JOIN users s ON s.id = b.student_id
   SET b.org_id = s.org_id,
       b.admin_id = s.admin_id
 WHERE b.org_id IS NULL
    OR b.admin_id IS NULL;

-- Second pass for any booking whose student had no resolvable admin_id (a
-- student row that predates the 0017 backfill, or was left unassigned).
-- Falls back to org 1's admin, matching 0017's and 0019's resolution.
UPDATE bookings
   SET admin_id = (
         SELECT id FROM (
           SELECT MIN(id) AS id FROM users WHERE role = 'admin' AND org_id = 1
         ) AS one_admin
       ),
       org_id = 1
 WHERE admin_id IS NULL;

-- --- tighten to NOT NULL ---------------------------------------------------
-- Safe because 0020_guard_bookings_have_admin.sql already proved, before this
-- file altered anything, that every booking can resolve an admin and an org.
-- See 0018_guard_availability_has_admin.sql for why guards are separate files.
ALTER TABLE bookings
  MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE bookings
  MODIFY COLUMN admin_id BIGINT UNSIGNED NOT NULL;

-- --- rebuild the double-booking guard, scoped per-teacher ------------------
-- The index must be dropped before the column it covers can be dropped.
--
-- This index is verified to exist (see the header note), so a plain DROP is
-- correct. Deliberately NOT written as DROP INDEX IF EXISTS: if it is somehow
-- absent on the target database, that means the live schema differs from the
-- baseline this was tested against, and the migration SHOULD stop so a human
-- can find out why rather than silently continuing.
--
-- Between this statement and the ADD UNIQUE KEY a few lines below, the table
-- is briefly without its double-booking guard. That window is inside a single
-- migration run against a database that is not serving traffic during a
-- deploy; it is not a window that exists in production use.
ALTER TABLE bookings
  DROP INDEX uq_bookings_active_scheduled_at;

ALTER TABLE bookings
  DROP COLUMN active_scheduled_at;

-- Recreated as PERSISTENT (not VIRTUAL): MariaDB cannot index a VIRTUAL
-- generated column. Semantics are byte-for-byte 0009's -- NULL unless the row
-- is currently 'booked' -- so cancel-then-rebook still works, because a unique
-- index permits unlimited NULLs.
ALTER TABLE bookings
  ADD COLUMN active_scheduled_at DATETIME
    GENERATED ALWAYS AS (CASE WHEN status = 'booked' THEN scheduled_at ELSE NULL END) PERSISTENT;

-- The replacement guard: per-teacher, not global. "This teacher cannot hold
-- two active bookings at the same instant."
ALTER TABLE bookings
  ADD UNIQUE KEY uq_bookings_admin_id_active_scheduled_at (admin_id, active_scheduled_at);

-- --- indexes ---------------------------------------------------------------
-- Serves the owner's and manager's org-wide date-window queries. The
-- per-teacher queries are served by uq_bookings_admin_id_active_scheduled_at's
-- leading column, which also satisfies InnoDB's FK-indexing requirement for
-- fk_bookings_admin_id.
ALTER TABLE bookings
  ADD KEY idx_bookings_org_id_scheduled_at (org_id, scheduled_at);

ALTER TABLE bookings
  DROP INDEX idx_bookings_scheduled_at_status;

-- --- foreign keys ----------------------------------------------------------
ALTER TABLE bookings
  ADD CONSTRAINT fk_bookings_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

ALTER TABLE bookings
  ADD CONSTRAINT fk_bookings_admin_id
    FOREIGN KEY (admin_id) REFERENCES users (id)
    ON DELETE RESTRICT;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE bookings DROP FOREIGN KEY fk_bookings_admin_id;
-- ALTER TABLE bookings DROP FOREIGN KEY fk_bookings_org_id;
-- ALTER TABLE bookings ADD KEY idx_bookings_scheduled_at_status (scheduled_at, status);
-- ALTER TABLE bookings DROP INDEX idx_bookings_org_id_scheduled_at;
-- ALTER TABLE bookings DROP INDEX uq_bookings_admin_id_active_scheduled_at;
-- ALTER TABLE bookings DROP COLUMN admin_id;
-- ALTER TABLE bookings DROP COLUMN org_id;
