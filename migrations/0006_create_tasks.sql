-- 0006_create_tasks.sql
-- Creates the `tasks` table (Phase 5 domain schema).
--
-- Design notes:
--   - Freeform manual to-do storage only -- no auto-generation logic
--     anywhere in this app creates task rows; CRUD endpoints for this table
--     are out of scope for this migration/phase and expected as a follow-up
--     increment (matching how Phase 4.5 followed Phase 4).
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0005's
--     convention (no UUID overhead needed at this app's ~12-user scale).
--   - title: VARCHAR(255) NOT NULL, matches the free-text title convention
--     already used by surveys.title/videos.title.
--   - assigned_to: nullable FK -> users.id -- a task may exist unassigned.
--     ON DELETE SET NULL, mirroring surveys.student_id / videos.student_id /
--     invitations.user_id: deleting a user shouldn't force-delete every task
--     ever assigned to them; the task remains as an unassigned record.
--     The schema does not restrict assigned_to to either role -- same as
--     every other cross-role FK in this project, none of which enforce role
--     at the DB layer.
--   - status: ENUM('pending','done') NOT NULL DEFAULT 'pending' -- every task
--     starts in the state that needs action, matching invitations.status /
--     videos.status's "defaults to initial state" pattern.
--   - due_date: DATE NULL -- no time-of-day component requested for this
--     freeform to-do use case; nullable because not every task has one.
--   - created_by: NOT NULL FK -> users.id. ON DELETE RESTRICT -- audit trail
--     of task authorship, matching invitations.created_by / videos.uploaded_by
--     / comments.author_id's exact reasoning.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     every other table.
--
-- Security: task titles are free text that may reference a student's name
-- or situation -- PII-adjacent the same way comments.body/messages.body are.
-- ENCRYPTION='Y' intentionally NOT specified, matching 0001-0005's
-- established convention (Hostinger host has no keyring plugin). See
-- server/migrations/README.md.
--
-- Indexing:
--   - idx_tasks_assigned_to_status (assigned_to, status): assigned_to must
--     be indexed regardless (InnoDB FK requirement). status is appended
--     because this column pair only makes sense in service of a future
--     "list my pending tasks" query -- the obvious access pattern for this
--     table -- so composing it now costs nothing and avoids a near-certain
--     follow-up migration once tasks CRUD lands.
--   - idx_tasks_created_by (created_by): not the leftmost column of any
--     other index here, so needs its own index to satisfy InnoDB's FK
--     requirement -- same pattern as 0003/0004/0005's uploaded_by/author_id/
--     sender_id indexes.

CREATE TABLE tasks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  assigned_to BIGINT UNSIGNED NULL,
  status ENUM('pending', 'done') NOT NULL DEFAULT 'pending',
  due_date DATE NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tasks_assigned_to_status (assigned_to, status),
  KEY idx_tasks_created_by (created_by),
  CONSTRAINT fk_tasks_assigned_to
    FOREIGN KEY (assigned_to) REFERENCES users (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_tasks_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS tasks;
