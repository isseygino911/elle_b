-- 0020_guard_bookings_have_admin.sql
-- PRECONDITION GUARD for 0021_bookings_multi_tenant.sql. Changes no schema
-- and no data: it either succeeds silently or aborts the migration run.
--
-- See 0018_guard_availability_has_admin.sql for the full rationale behind
-- guards living in their own files (MariaDB's non-transactional DDL plus a
-- forward-only runner means an in-file guard leaves a half-altered table that
-- cannot simply be re-run), and for the alternatives that were tested and
-- rejected.
--
-- WHAT IT CHECKS
-- That every booking will be able to resolve both an owning admin and an org
-- once 0021 runs. 0021 backfills bookings.admin_id / org_id from each
-- booking's student, falling back to org 1's admin for any student that has
-- no admin_id of its own. A booking is therefore unresolvable only when BOTH
-- paths fail: its student has no admin_id AND there is no admin in org 1 to
-- fall back to.
--
-- This matters more here than anywhere else in the migration set. 0021 drops
-- and rebuilds the double-booking unique index; stopping halfway through that
-- file could leave the bookings table without its guard against
-- double-booking a teacher. Checking first means that file either runs
-- completely or not at all.
--
-- IF THIS FIRES: do NOT delete rows. Every listed booking belongs to a
-- student with no assigned teacher. Assign those students to an admin
-- (users.admin_id), or ensure at least one user has role='admin' in org 1,
-- then re-run `npm run migrate`.
--
-- Diagnostic query -- run this to see exactly which bookings are the problem:
--   SELECT b.id, b.student_id, b.scheduled_at
--     FROM bookings b JOIN users s ON s.id = b.student_id
--    WHERE s.admin_id IS NULL;

SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',STRICT_ALL_TABLES');

CREATE TEMPORARY TABLE _guard_0020 (
  ABORT_bookings_rows_have_no_resolvable_admin INT NOT NULL
);

-- One NULL per booking that 0021's backfill cannot resolve: the student has
-- no owning admin, and there is no admin in org 1 to fall back to.
INSERT INTO _guard_0020 (ABORT_bookings_rows_have_no_resolvable_admin)
SELECT NULL
  FROM bookings b
  LEFT JOIN users s ON s.id = b.student_id
 WHERE s.admin_id IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM users WHERE role = 'admin' AND org_id = 1
       );

DROP TEMPORARY TABLE _guard_0020;
