-- 0026_notifications_content_and_types.sql
-- Makes a notification row self-describing, and splits the `type` ENUM so a
-- row says what actually happened.
--
-- WHY
-- As created in 0007, a notification carries only (type, ref_id): a 4-value
-- enum plus a bare integer pointing into whichever table `type` implies. The
-- row has no title, no body, no actor, and no link. Two consequences visible
-- in the running app today:
--
--   1. The dashboard cannot render a sentence. elle_f's DashboardPage.jsx
--      prints the literal enum string ("comment") next to a raw SQL timestamp,
--      because that is the entire contents of the row. It is not a UI
--      oversight -- there is nothing else to show.
--   2. Booking created and booking cancelled are INDISTINGUISHABLE. Both
--      bookings.route.js call sites write type='booking' with the same
--      bookings.id in ref_id, so a client cannot tell "your lesson is
--      scheduled" from "your lesson is cancelled" even by fetching the
--      referenced row. Only created_at differs.
--
-- WHAT CHANGES
--   - type: split into specific values, so each notification names its event.
--     Existing 'booking' rows migrate to 'booking_created' (see the honesty
--     note below). New values also cover the events that produce no
--     notification at all today -- video upload/review, task assignment and
--     completion, invitation acceptance -- and 'broadcast' for 0027.
--   - title / body: the human-readable content, written at insert time.
--     Denormalised deliberately: the alternative is joining four different
--     tables at read time, and a hard-deleted referenced row (videos.route.js
--     does have a live DELETE endpoint, contrary to 0007's assumption that
--     none existed) would then render as a broken notification rather than a
--     historical one.
--   - actor_id: WHO caused this. 0007 documents user_id as "the RECIPIENT
--     (never the actor)", which leaves "Sarah commented on your video"
--     underivable from the row. ON DELETE SET NULL, not CASCADE: a departed
--     teacher's actions should leave the student's notification history
--     intact, merely unattributed.
--
-- HONESTY NOTE ON THE 'booking' BACKFILL
-- Existing 'booking' rows are remapped to 'booking_created' because that is
-- the more common case, NOT because it is known to be correct for each row.
-- The information needed to distinguish them was never recorded. Joining
-- bookings.status would misattribute too: a row cancelled after its creation
-- notification was sent now reads 'cancelled', which says nothing about which
-- event the notification described. Some historical rows will therefore be
-- mislabelled, and no amount of care at this point can recover the truth.
-- Going forward the distinction is recorded correctly.
--
-- ON DROPPING 'class_video'
-- 0007 added 'class_video' "ahead of its feature, purely so this ENUM never
-- needs a future ALTER". No code path has ever inserted it -- verified by
-- grep across the codebase, and re-verified at the top of this migration by
-- an assertion that fails loudly rather than silently discarding rows. It is
-- removed rather than carried forward, because the replacement values
-- ('video_uploaded', 'video_reviewed') name the actual events, and an
-- always-empty enum member is exactly the speculative infrastructure 0012's
-- header argues against keeping.
--
-- STATEMENT GROUPING
-- Production is MariaDB 11.8, not MySQL (see 0012's "Statement grouping
-- note", and docker-compose.dev.yml's header). 0012 hit errno 121 applying a
-- batched multi-clause ALTER there that was valid MySQL and valid schema.
-- Every ALTER below is therefore issued as its own statement, each with a
-- single concern, rather than batched into one. Slower; survivable.
--
-- Security: title/body introduce free text into a table that previously held
-- none, so this row is now as PII-sensitive as messages/comments. Content is
-- written by the server from server-side values, never echoed from client
-- input, and the same host constraint applies as everywhere else:
-- ENCRYPTION='Y' intentionally NOT specified (Hostinger host has no keyring
-- plugin). See migrations/README.md.
--
-- Indexing:
--   - idx_notifications_user_id_read_at_created_at (user_id, read_at,
--     created_at) is added for the unread poll. The dashboard polls
--     GET /notifications?unread=true every 15 seconds
--     (DashboardPage.jsx:42), which filters on read_at IS NULL and orders by
--     created_at -- a pattern 0007's (user_id, created_at) index serves only
--     partially, since it must scan and discard read rows.
--   - 0007's original index is KEPT: it still serves the unfiltered list.
--   - No index on actor_id: nothing queries "notifications caused by X".
--     Speculative, per 0007's own reasoning about type/ref_id.

-- Fail loudly if the 'class_video' assumption is wrong. A migration that
-- silently discarded live rows would be far worse than one that refuses to
-- apply.
--
-- The obvious spelling of this -- CASE WHEN COUNT(*) = 0 THEN 1 ELSE
-- <bogus identifier> END -- does NOT work: column references are resolved
-- when the statement is parsed, not when the CASE branch is reached, so the
-- assertion fires unconditionally even against an empty table. (Verified:
-- it failed exactly that way on a clean schema.)
--
-- This form is genuinely conditional. Dividing by zero yields NULL in
-- MySQL/MariaDB rather than an error, so it cannot be used either; instead
-- the subquery is forced to produce a duplicate key. Zero offending rows
-- inserts one row and succeeds; one or more inserts the same literal twice
-- and violates the primary key, aborting the migration before any ALTER
-- runs.
CREATE TEMPORARY TABLE migration_0026_assert (
  guard TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (guard)
);

INSERT INTO migration_0026_assert (guard)
SELECT 0
UNION ALL
SELECT 0 FROM notifications WHERE type = 'class_video';

DROP TEMPORARY TABLE migration_0026_assert;

-- Widen the ENUM before remapping, so both old and new values are legal
-- while the UPDATE runs. 'class_video' is retained in this intermediate
-- state purely so the statement is valid against the current data.
ALTER TABLE notifications
  MODIFY COLUMN type ENUM(
    'message',
    'comment',
    'booking',
    'class_video',
    'booking_created',
    'booking_cancelled',
    'video_uploaded',
    'video_reviewed',
    'task_assigned',
    'task_completed',
    'invitation_accepted',
    'broadcast'
  ) NOT NULL;

-- Remap historical rows. See the honesty note above.
UPDATE notifications SET type = 'booking_created' WHERE type = 'booking';

-- Narrow to the final set, now that no row holds a retired value.
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
    'broadcast'
  ) NOT NULL;

-- Human-readable content. DEFAULT '' rather than NULL so existing rows
-- satisfy NOT NULL without a separate backfill; they render as an empty
-- title, which is what they have always effectively been.
ALTER TABLE notifications
  ADD COLUMN title VARCHAR(255) NOT NULL DEFAULT '' AFTER type;

ALTER TABLE notifications
  ADD COLUMN body TEXT NULL DEFAULT NULL AFTER title;

-- Who caused it. Nullable: historical rows have no recorded actor, and
-- ON DELETE SET NULL means a deleted user does not take the recipient's
-- notification history with them.
ALTER TABLE notifications
  ADD COLUMN actor_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER user_id;

ALTER TABLE notifications
  ADD CONSTRAINT fk_notifications_actor_id
    FOREIGN KEY (actor_id) REFERENCES users (id)
    ON DELETE SET NULL;

-- Serves the 15-second unread poll (see Indexing note above).
ALTER TABLE notifications
  ADD KEY idx_notifications_user_id_read_at_created_at (user_id, read_at, created_at);

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE notifications DROP KEY idx_notifications_user_id_read_at_created_at;
-- ALTER TABLE notifications DROP FOREIGN KEY fk_notifications_actor_id;
-- ALTER TABLE notifications DROP COLUMN actor_id;
-- ALTER TABLE notifications DROP COLUMN body;
-- ALTER TABLE notifications DROP COLUMN title;
-- UPDATE notifications SET type = 'booking' WHERE type IN ('booking_created', 'booking_cancelled');
-- ALTER TABLE notifications MODIFY COLUMN type ENUM('message','comment','booking','class_video') NOT NULL;
