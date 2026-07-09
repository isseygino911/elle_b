-- 0007_create_notifications.sql
-- Creates the `notifications` table (Phase 5 domain schema).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0006.
--   - user_id: NOT NULL FK -> users.id -- the RECIPIENT (never the actor).
--     ON DELETE CASCADE -- a notification has no purpose once its recipient
--     is gone, same reasoning as messages.student_id -> users.id in 0005.
--   - type: ENUM('message','comment','booking','class_video') NOT NULL -- the
--     four notification-triggering event kinds this schema anticipates.
--     Only 'message' and 'comment' have an INSERT call site as of this
--     migration (messages.route.js, comments.route.js). 'booking' and
--     'class_video' exist in the ENUM now, ahead of their features, purely
--     so this ENUM never needs a future ALTER -- no code path inserts either
--     value yet, and none should until those features actually exist.
--   - ref_id: BIGINT UNSIGNED NOT NULL -- the id of the row that triggered
--     this notification (messages.id when type='message', comments.id when
--     type='comment', and in future bookings.id/videos.id).
--
--     ref_id deliberately has NO foreign key constraint. One column cannot
--     FK against more than one target table, and which table it points into
--     varies by this row's own `type`. Alternatives that would allow a real
--     FK (one nullable FK column per possible target, or a generic
--     ref_table+ref_id EAV pair) are speculative infrastructure this app
--     doesn't need at ~12-user scale for four event kinds, two of which
--     have no producing feature yet. Accepted explicitly instead:
--       * Referential integrity for ref_id is enforced entirely at the
--         application layer -- both insert call sites write the notification
--         in the SAME transaction as the row it references, so ref_id is
--         always valid at insert time.
--       * If a referenced row is ever hard-deleted later, ref_id would dangle.
--         No delete endpoint exists today for messages, comments, videos, or
--         (once built) bookings, so this is a documented theoretical risk,
--         not something any current code path can trigger. Revisit if/when
--         a delete feature is added for any of the four referenced tables.
--   - read_at: TIMESTAMP NULL DEFAULT NULL -- same pattern/type as
--     messages.read_at in 0005; NULL means unread.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     every other table.
--
-- Security: holds no free text (unlike comments/messages/tasks) -- just a
-- recipient id, an enum, a referenced id, and timestamps -- markedly less
-- PII-sensitive than this project's other tables. Same host constraint
-- still applies: ENCRYPTION='Y' intentionally NOT specified (Hostinger host
-- has no keyring plugin). See server/migrations/README.md.
--
-- Indexing:
--   - idx_notifications_user_id_created_at (user_id, created_at): serves
--     both actual query patterns here -- "list this user's notifications,
--     most recent first" (optionally filtered to read_at IS NULL) and
--     "count this user's unread notifications" -- with one composite index.
--     Leftmost column also satisfies InnoDB's FK-indexing requirement for
--     fk_notifications_user_id.
--   - No index on `type` or `ref_id`: neither is filtered on by any query
--     this app actually runs (always listed/counted per-recipient) -- an
--     index on either would be speculative.

CREATE TABLE notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  type ENUM('message', 'comment', 'booking', 'class_video') NOT NULL,
  ref_id BIGINT UNSIGNED NOT NULL,
  read_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notifications_user_id_created_at (user_id, created_at),
  CONSTRAINT fk_notifications_user_id
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS notifications;
