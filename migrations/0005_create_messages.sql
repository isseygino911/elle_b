-- 0005_create_messages.sql
-- Creates the `messages` table (Phase 5 domain schema).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0004's
--     convention (no UUID overhead needed at this app's ~12-user scale).
--   - student_id: NOT NULL FK -> users.id (the thread key — every message
--     belongs to exactly one student's thread with Elle). Unlike
--     videos.student_id (nullable, a class video may have no single student
--     attached), a message thread is not meaningful without a student, so
--     this is NOT NULL. ON DELETE CASCADE — a thread has no purpose once its
--     student is gone, same reasoning as comments.video_id -> videos.id
--     (deleting the parent removes the dependent rows rather than leaving
--     orphans or being blocked by RESTRICT).
--   - sender_id: NOT NULL FK -> users.id (whichever account, Elle or
--     student, actually sent this message). ON DELETE RESTRICT — this is the
--     audit trail of who sent a message, matching comments.author_id's and
--     videos.uploaded_by's exact reasoning (a user row shouldn't be
--     deletable out from under existing message attribution).
--   - body: TEXT NOT NULL, matches the free-text convention already used by
--     comments.body / survey_questions.question_text.
--   - read_at: TIMESTAMP NULL DEFAULT NULL — set once by the app when the
--     recipient reads the message, and never reset afterward. NULL means
--     unread. Nullable TIMESTAMP for an event that may not have happened
--     yet, same pattern class as invitations.user_id being unset until
--     redeemed (different column, same "absent until an event occurs" idea).
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching the
--     created_at pattern used on every other table.
--
--   Both FKs on this table reference the SAME parent table (users) — one
--   pointing at the student who owns the thread, the other at whoever sent
--   this particular message. This is not a new pattern for this project:
--   0001's `invitations` table already has two FKs to `users`
--   (fk_invitations_user_id and fk_invitations_created_by) with the same
--   SET NULL / RESTRICT split rationale used there. This migration's
--   comment originally flagged this as unprecedented relative to 0001-0004;
--   that was incorrect and has been corrected here after checking 0001.
--
--   Because sender_id can independently be either the student or Elle,
--   ON DELETE RESTRICT on sender_id combined with ON DELETE CASCADE on
--   student_id deserves a specific call-out: this app enforces at the
--   application layer that a student may only ever be sender_id on a row
--   where student_id equals that same student. Under that invariant,
--   deleting a student cascades away every message row where they are
--   student_id — including rows where they are also sender_id — so
--   sender_id's RESTRICT never actually blocks a student's own deletion in
--   practice today (there's no other user row that FK could still be
--   pointing at once the CASCADE from student_id has already removed the
--   row). RESTRICT only meaningfully protects Elle's account today, since
--   Elle can be sender_id on many different students' threads and shouldn't
--   be deletable out from under all of that message history via one
--   student's deletion.
--   This should be revisited if/when a user-deletion feature is ever added
--   — none exists anywhere in this app currently, so the interaction above
--   is presently theoretical rather than something a live delete path
--   exercises. If deletion is added, re-verify whether RESTRICT on
--   sender_id still behaves as intended once a real DELETE users statement
--   exists, particularly for any future case where the sender/student
--   invariant above might not hold.
--
-- Security: message bodies are free text exchanged between a student and
-- Elle and may contain PII (the same category of risk already noted for
-- comments.body and videos). ENCRYPTION='Y' is intentionally NOT specified
-- here, matching the now-corrected convention across 0001-0004 — this
-- project's production host (Hostinger-managed MySQL) does not have the
-- keyring plugin configured, so InnoDB tablespace encryption is not
-- available; at-rest encryption for this data is therefore NOT currently
-- enforced at the database layer. innodb_file_per_table (MySQL 8 default)
-- is still in effect, same as prior migrations, but that alone does not
-- encrypt data at rest. This is a host-driven gap, not a design choice made
-- for this table specifically — see server/migrations/README.md.
--
-- Indexing:
--   - idx_messages_student_id_created_at (student_id, created_at): serves
--     the "list this thread's messages in order" query pattern, same
--     reasoning as 0003's idx_videos_student_id_created_at and 0004's
--     idx_comments_video_id_created_at. Since student_id is the leftmost
--     column, this also satisfies InnoDB's requirement that
--     fk_messages_student_id's column be indexed, so no separate
--     single-column index is added on top of it.
--   - idx_messages_sender_id (sender_id): unlike student_id, sender_id is
--     not the leftmost column of any other index on this table, so it needs
--     its own explicit index to satisfy InnoDB's requirement that
--     fk_messages_sender_id's column be indexed — same pattern as 0003's
--     idx_videos_uploaded_by and 0004's idx_comments_author_id.
--   Neither index is speculative — each maps to either a stated query
--   pattern or an InnoDB foreign-key indexing requirement.

CREATE TABLE messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_messages_student_id_created_at (student_id, created_at),
  KEY idx_messages_sender_id (sender_id),
  CONSTRAINT fk_messages_student_id
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender_id
    FOREIGN KEY (sender_id) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js — forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS messages;
