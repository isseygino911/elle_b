-- 0002_create_surveys.sql
-- Creates the `surveys` and `survey_questions` tables (Phase 2 domain schema).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT on both tables, matching
--     0001's convention (no UUID overhead needed at this app's ~12-user
--     scale).
--   - surveys.student_id: nullable FK -> users.id. ON DELETE SET NULL rather
--     than CASCADE, mirroring invitations.user_id's existing pattern — a
--     survey can be uploaded before it's assigned to a student, and a
--     student being removed shouldn't force-delete the survey record (the
--     file/history can remain as an unassigned record). Nullability is
--     required by the "surveys can exist unassigned" requirement.
--   - surveys.s3_key: VARCHAR(512), sized generously because the app
--     generates keys as a UUID + sanitized original filename, which can run
--     long; 512 leaves headroom without needing TEXT.
--   - surveys.original_filename: VARCHAR(255), matches the existing
--     VARCHAR(255) convention used for other free-text name fields
--     (users.name, invitations.student_name_hint).
--   - surveys.uploaded_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
--     matching the created_at pattern used elsewhere, named uploaded_at
--     here because it specifically marks the upload event.
--   - survey_questions.survey_id: NOT NULL FK -> surveys.id. ON DELETE
--     CASCADE — a question row is meaningless without its parent survey, so
--     deleting a survey should remove its questions rather than leaving
--     orphans or being blocked by RESTRICT.
--   - survey_questions.order_index / points: SMALLINT UNSIGNED — plenty of
--     range for per-survey question counts and point values; no need for
--     INT here.
--   - survey_questions.created_at: TIMESTAMP NOT NULL DEFAULT
--     CURRENT_TIMESTAMP, matching the created_at pattern used on every
--     other table so question-row creation is auditable like everything
--     else.
--
-- Security: `surveys` links directly to a specific student via student_id
-- and its original_filename is user-supplied (may itself contain a
-- student's name or other identifying text), so it's PII-adjacent the same
-- way invitations.student_name_hint is. `survey_questions` inherits that
-- sensitivity by association (each row belongs to one specific student's
-- survey). ENCRYPTION='Y' was originally specified on both tables here but
-- has been removed — this project's production host (Hostinger-managed
-- MySQL) does not have the keyring plugin configured, so InnoDB tablespace
-- encryption is not available; at-rest encryption for this data is
-- therefore NOT currently enforced at the database layer.
-- innodb_file_per_table (MySQL 8 default) is still in effect, same as 0001,
-- but that alone does not encrypt data at rest.
--
-- Indexing:
--   - idx_surveys_student_id_uploaded_at (student_id, uploaded_at): the app's
--     "list surveys for student X, most recent first" query pattern needs a
--     lookup by student_id with results ordered by uploaded_at. A single
--     composite index does both jobs (equality on student_id + sorted
--     range) and, since student_id is the leftmost column, also satisfies
--     InnoDB's requirement that FK columns be indexed — so no separate
--     single-column index is added on top of it.
--   - idx_survey_questions_survey_id_order_index (survey_id, order_index):
--     the app's "render a survey's questions in order" query pattern needs
--     a lookup by survey_id with results ordered by order_index. Same
--     reasoning as above — one composite index covers both the query
--     pattern and the FK's indexing requirement, avoiding a redundant plain
--     index on survey_id alone.
--   Neither index is speculative — both map directly to a stated query
--   pattern, and at this app's scale (12 users, a handful of surveys/student)
--   no further indexing is warranted.

CREATE TABLE surveys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id BIGINT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL,
  s3_key VARCHAR(512) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_surveys_student_id_uploaded_at (student_id, uploaded_at),
  CONSTRAINT fk_surveys_student_id
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE survey_questions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  survey_id BIGINT UNSIGNED NOT NULL,
  order_index SMALLINT UNSIGNED NOT NULL,
  question_text TEXT NOT NULL,
  points SMALLINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_survey_questions_survey_id_order_index (survey_id, order_index),
  CONSTRAINT fk_survey_questions_survey_id
    FOREIGN KEY (survey_id) REFERENCES surveys (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js — forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS survey_questions;
-- DROP TABLE IF EXISTS surveys;
