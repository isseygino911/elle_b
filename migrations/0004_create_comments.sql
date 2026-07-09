-- 0004_create_comments.sql
-- Creates the `comments` table (Phase 4 domain schema).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001/0002/0003's
--     convention (no UUID overhead needed at this app's ~12-user scale).
--   - video_id: NOT NULL FK -> videos.id. ON DELETE CASCADE — a comment is
--     meaningless without its parent video, same reasoning as
--     survey_questions.survey_id -> surveys.id in 0002 (deleting the video
--     should remove its comments rather than leaving orphans or being
--     blocked by RESTRICT).
--   - author_id: NOT NULL FK -> users.id (the account that wrote the
--     comment; either role can comment). ON DELETE RESTRICT — this is the
--     audit trail of who authored feedback on a video, matching
--     videos.uploaded_by's exact reasoning (a user row shouldn't be
--     deletable out from under existing comment attribution).
--   - body: TEXT NOT NULL, matches the free-text convention already used by
--     survey_questions.question_text.
--   - timestamp_sec: INT UNSIGNED NULL — an optional "this comment refers to
--     this point in the video" marker (NULL for a general comment not tied
--     to a specific moment). Same type/nullability as videos.duration_sec:
--     INT UNSIGNED comfortably covers any realistic video length, and it's
--     nullable because not every comment is timestamp-anchored.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching the
--     created_at pattern used on every other table.
--
-- Security: Comment bodies are free text tied to a specific student's video
-- and may reference PII (student name, performance details, etc.).
-- ENCRYPTION='Y' was originally specified here (following the same
-- conservative posture already applied to users/invitations (0001),
-- surveys/survey_questions (0002), and videos (0003)) but has been removed
-- — this project's production host (Hostinger-managed MySQL) does not have
-- the keyring plugin configured, so InnoDB tablespace encryption is not
-- available; at-rest encryption for this data is therefore NOT currently
-- enforced at the database layer. innodb_file_per_table (MySQL 8 default)
-- is still in effect, same as prior migrations, but that alone does not
-- encrypt data at rest.
--
-- Indexing:
--   - idx_comments_video_id_created_at (video_id, created_at): serves the
--     "list this video's comments in order" query pattern, same reasoning as
--     0002's idx_surveys_student_id_uploaded_at and 0003's
--     idx_videos_student_id_created_at. Since video_id is the leftmost
--     column, this also satisfies InnoDB's requirement that
--     fk_comments_video_id's column be indexed, so no separate
--     single-column index is added on top of it.
--   - idx_comments_author_id (author_id): unlike video_id, author_id is not
--     the leftmost column of any other index on this table, so it needs its
--     own explicit index to satisfy InnoDB's requirement that
--     fk_comments_author_id's column be indexed — same pattern as 0003's
--     idx_videos_uploaded_by.
--   Neither index is speculative — each maps to either a stated query
--   pattern or an InnoDB foreign-key indexing requirement.

CREATE TABLE comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  video_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  timestamp_sec INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_comments_video_id_created_at (video_id, created_at),
  KEY idx_comments_author_id (author_id),
  CONSTRAINT fk_comments_video_id
    FOREIGN KEY (video_id) REFERENCES videos (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_comments_author_id
    FOREIGN KEY (author_id) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js — forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS comments;
