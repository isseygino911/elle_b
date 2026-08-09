-- 0034_notifications_assignment_types.sql
-- Widens notifications.type for the courses/assignments/submissions feature
-- (0030-0033).
--
-- Five new members, one per event the routes actually insert:
--
--   assignment_published -- to each enrolled student, when a teacher moves an
--                           assignment from draft to published.
--   submission_received  -- to the course's teacher, when a student submits.
--   submission_reviewed  -- to the student, when the teacher leaves feedback
--                           and marks the submission reviewed.
--   course_enrolled      -- to the course's TEACHER, when an owner enrolls a
--                           student the teacher does not otherwise teach.
--                           Enrolling grants that teacher access to the
--                           student's submissions, so the grant is announced
--                           rather than silent. Not sent when a teacher
--                           enrolls their own student (they performed the act)
--                           or when the student is already on their roster
--                           (no new access is granted).
--   course_deleted       -- to each student who had submitted work, when the
--                           course's creator hard-deletes it. Their submissions
--                           go with the course (FK CASCADE), so this is the
--                           only record they will have that the work existed.
--                           Carries no ref_id target that survives -- see the
--                           note below.
--
-- ON course_deleted AND ref_id
-- Every other type here points ref_id at a row the client can open. This one
-- deliberately cannot: the course it names is gone by the time the notification
-- is read. ref_id still carries the deleted course's id, because it is the only
-- stable handle for de-duplication and for cleaning these rows up later, but a
-- client MUST NOT render it as a link. The title carries the course name so the
-- notification stays meaningful without a target to open.
--
-- No speculative members. 0026's header argues the case: an enum value with no
-- writer is a claim the schema makes and the code does not honour, and it is
-- one ALTER away whenever it is genuinely needed. There is deliberately no
-- 'assignment_due_soon' here -- nothing schedules reminders yet.
--
-- WIDENING ONLY -- this is a safe operation on existing data. Every value
-- present in 0026's list is repeated below verbatim, so no stored row's type
-- becomes invalid. MariaDB rewrites the column definition without touching row
-- data when the new set is a superset of the old. Contrast 0026 itself, which
-- REMOVED 'booking' and 'class_video' and therefore had to remap rows first.
--
-- ENGINE NOTE: MariaDB 11.8 in production. Each statement stands alone, per
-- the convention established in 0012/0017 (batched multi-clause ALTER TABLE
-- reproduces errno 121 here).
--
-- Security: no new data is stored by this migration; it only admits three more
-- labels into an existing column. Same host constraint as everywhere else:
-- ENCRYPTION='Y' intentionally NOT specified (Hostinger host has no keyring
-- plugin). See migrations/README.md.

ALTER TABLE notifications
  MODIFY COLUMN type ENUM(
    'message',
    'comment',
    'booking_created',
    'booking_cancelled',
    'video_uploaded',
    'video_reviewed',
    'task_assigned',
    'task_completed',
    'invitation_accepted',
    'broadcast',
    'assignment_published',
    'submission_received',
    'submission_reviewed',
    'course_enrolled',
    'course_deleted'
  ) NOT NULL;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only). Note this would FAIL if any row already
-- carries one of the three new types; those rows must be removed or remapped
-- first:
-- ALTER TABLE notifications
--   MODIFY COLUMN type ENUM(
--     'message', 'comment', 'booking_created', 'booking_cancelled',
--     'video_uploaded', 'video_reviewed', 'task_assigned', 'task_completed',
--     'invitation_accepted', 'broadcast'
--   ) NOT NULL;
