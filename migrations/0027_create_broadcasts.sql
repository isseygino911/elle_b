-- 0027_create_broadcasts.sql
-- One-to-many announcements: an owner addressing the whole organization, or a
-- teacher addressing their own roster.
--
-- WHY A TABLE AT ALL, when fan-out already writes one notifications row per
-- recipient and those rows are self-describing after 0026:
--
--   1. The SENT message is a single fact. Without this table, "what did I
--      send?" has to be reconstructed by grouping notifications on
--      (actor_id, created_at, title) and hoping no two announcements collide
--      -- a heuristic, not a key. The sender's own outbox is a first-class
--      view, so it gets a first-class row.
--   2. It is what the manager oversight view reads. See recipient_count below;
--      that column is the entire reason the manager tier can see broadcast
--      activity at all without breaching the privacy boundary.
--
-- The notifications rows remain the delivery mechanism and keep their own copy
-- of title/body, so the recipient's list renders without joining this table --
-- consistent with 0026's denormalisation argument.
--
-- ON recipient_count BEING DENORMALISED
-- This is deliberate and is the load-bearing design decision in this file.
--
-- constants/roles.js draws a hard line: `manager` outranks `admin` but must
-- NEVER read an individual student's records. A manager overseeing broadcast
-- activity legitimately needs to know that a teacher messaged their roster and
-- how far it reached. Computing that live means
-- `SELECT COUNT(*) FROM notifications WHERE ref_id = ? AND type = 'broadcast'`
-- -- a query whose WHERE clause is the recipient set the manager is forbidden
-- to see, and whose one-character edit (COUNT(*) -> user_id) turns an
-- aggregate into a roster.
--
-- Storing the count at send time means the oversight read never touches
-- notifications at all. The privacy boundary is enforced by the shape of the
-- data the query can reach, not by the discipline of whoever writes the query
-- next. That is worth one denormalised integer.
--
-- The usual objection to denormalisation -- it can drift from the truth --
-- does not apply here: a broadcast is immutable once sent. There is no
-- UPDATE path, no recipient is added afterwards, and a recipient whose account
-- is later deleted does not retroactively make the announcement have reached
-- fewer people at the time it was sent.
--
-- ON audience BEING STORED FOR TEACHERS TOO
-- A teacher can only ever address their own students, so their row always
-- reads 'students'. The column is still NOT NULL with no teacher-specific
-- exemption: the value is a factual record of who was addressed, and a nullable
-- column would invite a reader to treat NULL as "unknown" when it is in fact
-- fully known. The route enforces which values each role may send.
--
-- ENGINE NOTE: MariaDB 11.8 in production. Each statement stands alone, per
-- the convention established in 0012/0017 (batched multi-clause ALTER TABLE
-- reproduces errno 121 here).
--
-- Security: body is free text authored by a user and fanned out to many
-- recipients, so this table is as PII-sensitive as messages. Same host
-- constraint as everywhere else: ENCRYPTION='Y' intentionally NOT specified
-- (Hostinger host has no keyring plugin). See migrations/README.md.

CREATE TABLE broadcasts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  -- Who was addressed. 'teachers' and 'both' are owner-only; a teacher's
  -- broadcast is always 'students', meaning "the students on my roster" rather
  -- than "every student in the org". The distinction is carried by sender_id's
  -- role, not by a fifth enum value, because the same word means the same
  -- thing from each sender's vantage point.
  audience ENUM('students', 'teachers', 'both') NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  -- How many notifications rows this send produced. See the long note above:
  -- this exists so the manager oversight view never has to query the recipient
  -- set. UNSIGNED because a send that reached nobody is rejected by the route
  -- with a 400 rather than written as a zero-recipient row.
  recipient_count INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Serves both reads this table has: the owner's org-wide list and the
  -- manager's oversight feed, each ordered newest-first within an org.
  KEY idx_broadcasts_org_id_created_at (org_id, created_at),
  -- Serves the sender's own outbox.
  KEY idx_broadcasts_sender_id_created_at (sender_id, created_at),
  -- ON DELETE CASCADE: deleting an organization removes its announcements,
  -- matching every other org-scoped table from 0021/0023/0024.
  CONSTRAINT fk_broadcasts_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE CASCADE,
  -- ON DELETE CASCADE, unlike notifications.actor_id which is SET NULL.
  --
  -- The two are not inconsistent. A notification is the RECIPIENT's record and
  -- must survive the sender leaving -- unattributed, but intact. A broadcast
  -- row is the SENDER's record; with the sender gone there is no outbox to
  -- show it in and no oversight question it answers. The delivered
  -- notifications, which are what the recipients actually read, are unaffected
  -- either way because they carry their own copy of the content.
  CONSTRAINT fk_broadcasts_sender_id
    FOREIGN KEY (sender_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS broadcasts;
