-- 0023_content_multi_tenant.sql
-- Adds org_id to every remaining tenant-scoped content table, plus admin_id
-- where a row belongs to one teacher rather than to the org as a whole.
--
-- ENGINE NOTE: MariaDB 11.8 in production -- one ALTER per statement. See
-- migrations/README.md.
--
-- LIVE DATA: surveys and survey_responses hold real production data that must
-- survive. This migration ONLY ADDS COLUMNS -- no content is rewritten, no row
-- is deleted, and no column is dropped anywhere in this file.
--
-- WHICH TABLE GETS WHICH COLUMN, AND WHY
--
--   surveys       org_id only.
--                 A survey is org-level CURRICULUM, not one teacher's
--                 property. 0012 deliberately DROPPED surveys.student_id and
--                 redesigned the model to "one survey = visible to every
--                 student, each student takes it independently with their own
--                 progress". That design is preserved exactly and simply
--                 gains a tenant fence: a survey is visible to every student
--                 IN ITS ORGANIZATION. Re-introducing a per-teacher or
--                 per-student owner column here would undo 0012.
--
--   survey_questions / survey_answers
--                 org_id, inherited for query convenience. These are strict
--                 children of surveys and are only ever reached through a
--                 survey the caller was already authorized against, so the
--                 column is defence-in-depth rather than the primary fence.
--
--   survey_responses
--                 NOTHING. Deliberately. A response is already keyed by
--                 (question_id, student_id) -- see 0014's unique key -- and
--                 the student is org-scoped via users.org_id. Adding org_id
--                 here would create a second copy of a fact already recorded
--                 elsewhere, with a new opportunity for the two to disagree.
--                 This is the table holding real per-student answer data, and
--                 it is left completely untouched.
--
--   videos        org_id + admin_id. A practice video belongs to a student,
--                 and therefore to that student's teacher.
--
--   messages      org_id + admin_id. THE THREAD KEY CHANGES MEANING: 0005
--                 keyed a thread by student_id alone because there was
--                 exactly one possible other party. A thread is now
--                 (student_id, admin_id). Backfilled from the student's
--                 owning admin, which is correct because historically every
--                 message was to or from the single elle account.
--
--   tasks         org_id only. Ownership is already expressed by created_by /
--                 assigned_to; org_id is purely the tenancy fence.
--
--   notifications org_id only. Already recipient-scoped by user_id; org_id is
--                 defence-in-depth so a notification can never be listed
--                 cross-tenant even if a user_id were wrong.
--
--   invitations   org_id only. created_by already records the inviting
--                 teacher and becomes the student -> admin assignment
--                 mechanism, so no separate admin_id is needed.
--
--   comments      NOTHING. A strict child of videos, reached only via a video
--                 the caller was authorized against.

-- ===========================================================================
-- surveys  (org-level curriculum -- content untouched, column added only)
-- ===========================================================================
ALTER TABLE surveys ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

UPDATE surveys SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE surveys MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE surveys ADD KEY idx_surveys_org_id_uploaded_at (org_id, uploaded_at);

ALTER TABLE surveys
  ADD CONSTRAINT fk_surveys_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- ===========================================================================
-- survey_questions / survey_answers  (children of surveys)
-- ===========================================================================
ALTER TABLE survey_questions ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

UPDATE survey_questions q
  JOIN surveys s ON s.id = q.survey_id
   SET q.org_id = s.org_id
 WHERE q.org_id IS NULL;

UPDATE survey_questions SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE survey_questions MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE survey_questions
  ADD CONSTRAINT fk_survey_questions_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

ALTER TABLE survey_answers ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

UPDATE survey_answers a
  JOIN survey_questions q ON q.id = a.question_id
   SET a.org_id = q.org_id
 WHERE a.org_id IS NULL;

UPDATE survey_answers SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE survey_answers MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE survey_answers
  ADD CONSTRAINT fk_survey_answers_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- survey_responses: intentionally untouched. See the header.

-- ===========================================================================
-- videos
-- ===========================================================================
ALTER TABLE videos ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

ALTER TABLE videos ADD COLUMN admin_id BIGINT UNSIGNED NULL AFTER org_id;

-- LEFT JOIN because videos.student_id is NULLable (0003 permits class videos
-- with no student).
UPDATE videos v
  LEFT JOIN users s ON s.id = v.student_id
   SET v.org_id = COALESCE(s.org_id, 1),
       v.admin_id = s.admin_id
 WHERE v.org_id IS NULL;

-- Class videos with no student take their admin from the uploader: if the
-- uploader is a teacher it is them, otherwise the uploader's own teacher.
UPDATE videos v
  JOIN users u ON u.id = v.uploaded_by
   SET v.admin_id = CASE WHEN u.role = 'admin' THEN u.id ELSE u.admin_id END
 WHERE v.admin_id IS NULL;

ALTER TABLE videos MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

-- admin_id stays NULLable here: an org-level class video with no student and
-- a non-teacher uploader legitimately has no owning teacher, and such a video
-- is still meaningful as an org artifact.
ALTER TABLE videos ADD KEY idx_videos_org_id_created_at (org_id, created_at);

ALTER TABLE videos ADD KEY idx_videos_admin_id_status (admin_id, status);

ALTER TABLE videos
  ADD CONSTRAINT fk_videos_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- SET NULL, unlike messages below: a video survives as an org-level artifact
-- without a teacher.
ALTER TABLE videos
  ADD CONSTRAINT fk_videos_admin_id
    FOREIGN KEY (admin_id) REFERENCES users (id)
    ON DELETE SET NULL;

-- ===========================================================================
-- messages  (thread key becomes (student_id, admin_id))
-- ===========================================================================
ALTER TABLE messages ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

ALTER TABLE messages ADD COLUMN admin_id BIGINT UNSIGNED NULL AFTER org_id;

UPDATE messages m
  JOIN users s ON s.id = m.student_id
   SET m.org_id = s.org_id,
       m.admin_id = s.admin_id
 WHERE m.org_id IS NULL
    OR m.admin_id IS NULL;

UPDATE messages
   SET admin_id = (
         SELECT id FROM (
           SELECT MIN(id) AS id FROM users WHERE role = 'admin' AND org_id = 1
         ) AS one_admin
       ),
       org_id = 1
 WHERE admin_id IS NULL;

-- Safe because 0022_guard_messages_have_admin.sql already proved, before this
-- file altered any of its eight tables, that every message can resolve an
-- admin. See 0018_guard_availability_has_admin.sql for why guards are their
-- own migrations -- an in-file guard here was observed aborting AFTER adding
-- org_id to five tables, leaving a half-migrated schema that could not be
-- re-run.
ALTER TABLE messages MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE messages MODIFY COLUMN admin_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE messages
  ADD KEY idx_messages_admin_id_student_id_created_at (admin_id, student_id, created_at);

ALTER TABLE messages
  ADD CONSTRAINT fk_messages_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- RESTRICT, unlike videos above: a thread with no admin side is unreadable,
-- because the thread's identity is the (student, admin) pair.
ALTER TABLE messages
  ADD CONSTRAINT fk_messages_admin_id
    FOREIGN KEY (admin_id) REFERENCES users (id)
    ON DELETE RESTRICT;

-- ===========================================================================
-- tasks
-- ===========================================================================
ALTER TABLE tasks ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

UPDATE tasks t
  JOIN users u ON u.id = t.created_by
   SET t.org_id = u.org_id
 WHERE t.org_id IS NULL;

UPDATE tasks SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE tasks MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE tasks ADD KEY idx_tasks_org_id_status (org_id, status);

ALTER TABLE tasks
  ADD CONSTRAINT fk_tasks_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- ===========================================================================
-- notifications
-- ===========================================================================
ALTER TABLE notifications ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

UPDATE notifications n
  JOIN users u ON u.id = n.user_id
   SET n.org_id = u.org_id
 WHERE n.org_id IS NULL;

UPDATE notifications SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE notifications MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE notifications
  ADD CONSTRAINT fk_notifications_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- ===========================================================================
-- invitations
-- ===========================================================================
ALTER TABLE invitations ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

UPDATE invitations i
  JOIN users u ON u.id = i.created_by
   SET i.org_id = u.org_id
 WHERE i.org_id IS NULL;

UPDATE invitations SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE invitations MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

-- The role this invitation grants when redeemed. Until now auth.route.js
-- hardcoded role='student' at registration; an owner must be able to invite
-- admins and managers too. Defaults to 'student', which is what every
-- pre-existing invitation meant.
ALTER TABLE invitations
  ADD COLUMN role ENUM('manager', 'admin', 'student') NOT NULL DEFAULT 'student' AFTER org_id;

ALTER TABLE invitations ADD KEY idx_invitations_org_id_status (org_id, status);

ALTER TABLE invitations
  ADD CONSTRAINT fk_invitations_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only): drop the FKs, indexes and columns added
-- above, in reverse order, per table.
