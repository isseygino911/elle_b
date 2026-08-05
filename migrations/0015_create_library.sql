-- 0015_create_library.sql
-- Creates the `library_categories` and `library_files` tables (Library phase).
--
-- Design notes (library_categories):
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0014's
--     convention (no UUID overhead needed at this app's ~12-user scale).
--   - name: VARCHAR(255) NOT NULL, matching the free-text title convention
--     already used by surveys.title/videos.title/tasks.title. UNIQUE via
--     uq_library_categories_name: categories are a small admin-curated set
--     and two categories with the same name would make the move-file UI
--     ambiguous, so the constraint is load-bearing — the create-category
--     route relies on the UNIQUE-violation error to return a 409 rather
--     than racing a SELECT-then-INSERT check.
--     Note the utf8mb4_0900_ai_ci collation makes this uniqueness
--     case-insensitive ('Warmups' collides with 'warmups'), which is the
--     intended behavior for human-facing category names.
--   - created_by: NOT NULL FK -> users.id. ON DELETE RESTRICT — audit trail
--     of who curated the category, matching invitations.created_by /
--     videos.uploaded_by / tasks.created_by's exact reasoning.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     every other table.
--   - No explicit sort/position column: categories are listed alphabetically
--     by name, so there is no second ordering to persist. Adding a position
--     column now would be speculative.
--
-- Design notes (library_files):
--   - category_id: nullable FK -> library_categories.id, ON DELETE SET NULL.
--     Nullable is load-bearing in two places: a file may be uploaded before
--     it's filed anywhere, and deleting a category must leave its files
--     browsable as "Uncategorized" rather than destroying them. SET NULL is
--     what implements that second rule at the DB layer, so the delete-category
--     route doesn't need to re-file rows itself.
--   - title: VARCHAR(255) NOT NULL — the human-facing label, defaulted from
--     the original filename at upload time but independently editable.
--   - original_filename: VARCHAR(255) NOT NULL. Unlike videos (which keeps
--     the sanitized name only as the s3_key's last path segment), the
--     library shows a real download filename to the user and must round-trip
--     the pre-sanitization name, so it earns a first-class column here.
--   - s3_key: VARCHAR(512) NOT NULL, sized as surveys.s3_key/videos.s3_key.
--     UNIQUE via uq_library_files_s3_key — as with videos, this is
--     load-bearing: the confirm-upload flow relies on the UNIQUE violation
--     to reject a duplicate confirm for the same S3 object with a 409.
--   - content_type: VARCHAR(128) NOT NULL — needed to pick a file-type icon
--     in the UI and to set the right Content-Type on download without a
--     second S3 HeadObject round trip.
--   - size_bytes: BIGINT UNSIGNED NOT NULL — displayed in the list; BIGINT
--     because the allowed set includes video, which can exceed INT UNSIGNED.
--     NOT NULL because the confirm step always learns the true size from
--     S3's HeadObject before writing the row.
--   - description: TEXT NULL — optional free-form note about the resource.
--     TEXT rather than VARCHAR since there is no meaningful length cap on
--     an explanatory blurb, matching comments.body/messages.body.
--   - uploaded_by: NOT NULL FK -> users.id, ON DELETE RESTRICT — same audit
--     trail reasoning as videos.uploaded_by.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     every other table.
--
-- Security: library files are coach-curated teaching resources rather than
-- per-student records, but the download path is still auth-gated (no public
-- bucket reads — access is via short-lived presigned URLs only).
-- ENCRYPTION='Y' intentionally NOT specified, matching 0001-0014's
-- established convention (the Hostinger-managed host has no keyring plugin
-- configured, so InnoDB tablespace encryption is unavailable). See
-- migrations/README.md.
--
-- Indexing:
--   - idx_library_categories_created_by (created_by): not the leftmost
--     column of any other index on that table, so it needs its own index to
--     satisfy InnoDB's FK indexing requirement — same pattern as
--     0003/0004/0005/0006's uploaded_by/author_id/sender_id/created_by.
--   - idx_library_files_category_id_created_at (category_id, created_at):
--     serves the primary access pattern — "list the files in this category,
--     most recent first" — and, since category_id is leftmost, simultaneously
--     satisfies InnoDB's FK indexing requirement for fk_library_files_category_id.
--     Same composite reasoning as 0003's idx_videos_student_id_created_at.
--   - idx_library_files_created_at (created_at): serves the unfiltered
--     "all files, newest first" listing, which the category composite index
--     cannot serve (its leading column is category_id, so a query with no
--     category filter can't seek on it).
--   - idx_library_files_uploaded_by (uploaded_by): needed for InnoDB's FK
--     indexing requirement, same as videos.uploaded_by.
--   None of these indexes are speculative — each maps to either a stated
--   query pattern or an InnoDB foreign-key indexing requirement.

CREATE TABLE library_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_library_categories_name (name),
  KEY idx_library_categories_created_by (created_by),
  CONSTRAINT fk_library_categories_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE library_files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id BIGINT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  s3_key VARCHAR(512) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  description TEXT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_library_files_s3_key (s3_key),
  KEY idx_library_files_category_id_created_at (category_id, created_at),
  KEY idx_library_files_created_at (created_at),
  KEY idx_library_files_uploaded_by (uploaded_by),
  CONSTRAINT fk_library_files_category_id
    FOREIGN KEY (category_id) REFERENCES library_categories (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_library_files_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js — forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS library_files;
-- DROP TABLE IF EXISTS library_categories;
