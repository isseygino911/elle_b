-- 0003_create_videos.sql
-- Creates the `videos` table (Phase 3 domain schema).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001/0002's
--     convention (no UUID overhead needed at this app's ~12-user scale).
--   - type: ENUM('class','practice') NOT NULL — the two video kinds the app
--     distinguishes between (a recorded class session vs. a student's
--     practice submission). No default; every upload must declare which
--     kind it is at confirm-upload time.
--   - student_id: nullable FK -> users.id, ON DELETE SET NULL. Mirrors the
--     existing surveys.student_id / invitations.user_id pattern — a class
--     video may cover a group session with no single student attached (or
--     may be uploaded before assignment), and removing a student shouldn't
--     force-delete the video record (it can remain as an unassigned/orphaned
--     historical record).
--   - title: VARCHAR(255) NOT NULL, matches the existing VARCHAR(255)
--     convention used for other free-text name/title fields (users.name,
--     surveys.title).
--   - s3_key: VARCHAR(512) NOT NULL, sized the same as surveys.s3_key (keys
--     are generated as a UUID + sanitized filename and can run long; 512
--     leaves headroom without needing TEXT). UNIQUE via uq_videos_s3_key:
--     this is load-bearing, not just a nice-to-have — the confirm-upload
--     flow relies on a UNIQUE-violation error to detect and reject a second
--     confirm call for the same S3 object with a 409, so this constraint is
--     the mechanism that prevents the same upload from being recorded as two
--     DB rows.
--   - duration_sec: INT UNSIGNED NULL — duration is derived from the video
--     file itself (e.g. via a probe step) and may not be available at the
--     moment the row is first written, so it's nullable and backfilled once
--     known. INT UNSIGNED comfortably covers any realistic video length.
--   - status: ENUM('pending_review','reviewed') NOT NULL DEFAULT
--     'pending_review' — every video starts awaiting review, matching the
--     "defaults to the initial state" pattern already used by
--     invitations.status.
--   - uploaded_by: NOT NULL FK -> users.id (the account that performed the
--     upload). ON DELETE RESTRICT — this is the audit trail of who uploaded
--     the video; a user row shouldn't be deletable out from under existing
--     upload attribution. Matches invitations.created_by's RESTRICT
--     reasoning exactly.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching the
--     created_at pattern used on users/invitations/survey_questions (kept as
--     created_at rather than surveys' table-specific "uploaded_at" naming,
--     since created_at is this project's baseline convention and there's no
--     second competing timestamp on this table to disambiguate from).
--   - No original_filename column: unlike surveys, the sanitized original
--     filename is preserved only as the last path segment of s3_key, not as
--     a first-class column. This is the given schema's intentional design,
--     not an omission.
--
-- Security: Videos are student-linked (via student_id) and represent
-- sensitive class/practice recordings. ENCRYPTION='Y' was originally
-- specified here (following the same conservative posture already applied
-- to surveys/survey_questions in 0002) but has been removed — this
-- project's production host (Hostinger-managed MySQL) does not have the
-- keyring plugin configured, so InnoDB tablespace encryption is not
-- available; at-rest encryption for this data is therefore NOT currently
-- enforced at the database layer. innodb_file_per_table (MySQL 8 default)
-- is still in effect, same as prior migrations, but that alone does not
-- encrypt data at rest.
--
-- Indexing:
--   - idx_videos_student_id_created_at (student_id, created_at): serves the
--     "list this student's videos, most recent first" query pattern, same
--     reasoning as 0002's idx_surveys_student_id_uploaded_at. Since
--     student_id is the leftmost column, this also satisfies InnoDB's
--     requirement that fk_videos_student_id's column be indexed, so no
--     separate single-column index is added on top of it.
--   - idx_videos_status (status): serves the "show everything
--     pending_review across all students" list-filter query — a query
--     pattern 0002's surveys table has no equivalent of, since surveys has
--     no status column. Low cardinality (2 values) is acceptable here given
--     both the explicit stated query pattern and this app's small data
--     volume.
--   - idx_videos_uploaded_by (uploaded_by): unlike student_id and
--     survey_id/survey_questions.survey_id in 0002, uploaded_by is not the
--     leftmost column of any other index on this table, so it needs its own
--     explicit index to satisfy InnoDB's requirement that
--     fk_videos_uploaded_by's column be indexed (InnoDB would otherwise add
--     an unnamed index implicitly; naming it explicitly keeps it consistent
--     with and referenceable like every other index in this project).
--   None of these indexes are speculative — each maps to either a stated
--   query pattern or an InnoDB foreign-key indexing requirement.

CREATE TABLE videos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type ENUM('class', 'practice') NOT NULL,
  student_id BIGINT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL,
  s3_key VARCHAR(512) NOT NULL,
  duration_sec INT UNSIGNED NULL,
  status ENUM('pending_review', 'reviewed') NOT NULL DEFAULT 'pending_review',
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_videos_s3_key (s3_key),
  KEY idx_videos_student_id_created_at (student_id, created_at),
  KEY idx_videos_status (status),
  KEY idx_videos_uploaded_by (uploaded_by),
  CONSTRAINT fk_videos_student_id
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_videos_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js — forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS videos;
