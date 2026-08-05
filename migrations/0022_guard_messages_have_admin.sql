-- 0022_guard_messages_have_admin.sql
-- PRECONDITION GUARD for 0023_content_multi_tenant.sql. Changes no schema
-- and no data: it either succeeds silently or aborts the migration run.
--
-- See 0018_guard_availability_has_admin.sql for the full rationale behind
-- guards living in their own files, and for the alternatives tested and
-- rejected.
--
-- WHY THIS ONE MATTERS MOST
-- 0023 is the widest migration in the set -- it alters surveys,
-- survey_questions, survey_answers, videos, messages, tasks, notifications
-- and invitations. It is also the file that touches the tables holding real
-- production survey data. An in-file guard there was directly observed to
-- abort AFTER adding org_id to five tables, leaving the schema half-migrated
-- and the retry failing with ERROR 1060 "Duplicate column name 'org_id'".
-- Checking here, before 0023 touches anything, means a failure leaves every
-- one of those eight tables untouched.
--
-- WHAT IT CHECKS
-- That every message will be able to resolve an owning admin once 0023 runs.
-- A message thread's identity changes in 0023 from student_id alone to the
-- (student_id, admin_id) pair, and messages.admin_id is declared NOT NULL --
-- a thread with no admin side is unreadable, which is why that column cannot
-- be left nullable the way videos.admin_id can.
--
-- 0023 backfills messages.admin_id from the message's student, falling back
-- to org 1's admin. A message is unresolvable only when both paths fail.
--
-- NOTE: this guard covers messages only, not the other seven tables in 0023.
-- That is deliberate, not an oversight. Every other column 0023 adds either
-- backfills unconditionally to org 1 (surveys, tasks, notifications,
-- invitations, and the survey_questions / survey_answers children) or is left
-- nullable by design (videos.admin_id, which legitimately has no owning
-- teacher for an org-level class video). messages.admin_id is the only column
-- in that file that is both NOT NULL and dependent on a lookup that can fail.
--
-- IF THIS FIRES: do NOT delete rows. Assign the affected students to an admin
-- (users.admin_id), or ensure at least one user has role='admin' in org 1,
-- then re-run `npm run migrate`.
--
-- Diagnostic query:
--   SELECT m.id, m.student_id, LEFT(m.body, 40) AS body
--     FROM messages m JOIN users s ON s.id = m.student_id
--    WHERE s.admin_id IS NULL;

SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',STRICT_ALL_TABLES');

CREATE TEMPORARY TABLE _guard_0022 (
  ABORT_messages_rows_have_no_resolvable_admin INT NOT NULL
);

INSERT INTO _guard_0022 (ABORT_messages_rows_have_no_resolvable_admin)
SELECT NULL
  FROM messages m
  LEFT JOIN users s ON s.id = m.student_id
 WHERE s.admin_id IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM users WHERE role = 'admin' AND org_id = 1
       );

DROP TEMPORARY TABLE _guard_0022;
