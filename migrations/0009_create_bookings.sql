-- 0009_create_bookings.sql
-- Creates the `bookings` table (Phase 6 domain schema).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0008.
--   - student_id: NOT NULL FK -> users.id -- every booking belongs to
--     exactly one student (Elle is not stored per-row; she is the
--     implicit other party, same reasoning as availability's lack of an
--     owner column). ON DELETE CASCADE, matching messages.student_id's
--     exact rationale from 0005: a booking has no purpose once its
--     student is gone.
--   - scheduled_at: DATETIME NOT NULL. This is intentionally DATETIME, not
--     TIMESTAMP, unlike every other date/time column in this project
--     (created_at, read_at, due_date aside). MySQL TIMESTAMP is stored as
--     a UTC instant internally and is converted to/from the session's
--     `time_zone` setting on every read/write; DATETIME has no timezone
--     awareness at all -- MySQL stores and returns exactly the wall-clock
--     digits given to it, with zero implicit conversion at any layer.
--     scheduled_at's contract is: it always holds a UTC wall-clock value,
--     written and read by the application, never re-interpreted by MySQL
--     against a session timezone. Using TIMESTAMP here would make
--     correctness depend on the DB session's `time_zone` setting always
--     being UTC (currently true, but not something this column should
--     silently depend on for a value this precision-critical -- getting a
--     booking's time wrong is a real product bug, not just a display
--     nit). DATETIME removes that dependency entirely: correctness here
--     is 100% the application's responsibility, verifiable by reading
--     bookings.helpers.js's two small conversion functions, and never
--     MySQL's.
--     IMPLEMENTATION REQUIREMENT for the backend engineer: mysql2 returns
--     DATETIME columns as JS Date objects by default, constructed by
--     interpreting the raw value against mysql2's own `timezone` client
--     option (default 'local', NOT necessarily UTC, and NOT currently set
--     in server/src/db/pool.js). Every query touching scheduled_at MUST
--     request it as a raw string (mysql2's per-query `{ sql, dateStrings:
--     true }`, or a pool-level `dateStrings: ['DATETIME']`), and
--     bookings.helpers.js MUST own the two pure string converters used at
--     every point scheduled_at crosses the SQL boundary.
--   - duration_min: TINYINT UNSIGNED NOT NULL DEFAULT 30 (max 255 minutes,
--     4h15m -- ample headroom for any tutoring-session length without
--     needing a wider type). Defaults to 30 to match the open-slots
--     computation's fixed 30-minute slot granularity, but this column is
--     independent storage, not read by the open-slots generator itself.
--   - status: ENUM('booked','completed','cancelled') NOT NULL DEFAULT
--     'booked' -- every booking starts in the state that represents an
--     upcoming, not-yet-happened session, matching invitations.status /
--     videos.status / tasks.status's "defaults to initial state" pattern.
--     No code path transitions a row to 'completed' as of this migration
--     -- that would be a future automated or manual process, out of scope
--     for Phase 6. 'completed' exists in the ENUM now purely so a later
--     migration is not needed to add it, same reasoning as 'booking' /
--     'class_video' sitting unused in notifications.type ahead of their
--     features (see 0007).
--   - jitsi_room_id: VARCHAR(36) NOT NULL -- a placeholder meeting-room
--     identifier that Phase 7 (not built yet) will use to construct an
--     actual Jitsi meeting URL. Generated in application code as a
--     crypto.randomUUID() (Node's built-in `crypto` module, no new
--     dependency) BEFORE the INSERT. A random UUID is chosen over a
--     sequential "booking-<id>" scheme specifically because a sequential
--     room name is trivially guessable/enumerable by anyone who has seen
--     one -- an information-leak Phase 7 would otherwise inherit for
--     free. VARCHAR(36) is the exact canonical UUID string length (32 hex
--     digits + 4 hyphens).
--   - active_scheduled_at: DATETIME, a VIRTUAL generated column defined as
--     `CASE WHEN status = 'booked' THEN scheduled_at ELSE NULL END`, with
--     a UNIQUE index on it. This is the DB-level backstop against
--     double-booking the exact same instant, justified because this is a
--     single-tutor 1:1 scheduling app -- Elle can only be in one meeting
--     at a time, so no two 'booked' rows should ever legitimately share a
--     scheduled_at value. A plain UNIQUE(scheduled_at) would be wrong: it
--     would also block a student from re-booking the exact same slot
--     after an earlier booking at that instant was cancelled. Using a
--     generated column that evaluates to NULL for any non-'booked' row
--     sidesteps that -- MySQL's UNIQUE index permits any number of NULLs
--     -- so only currently-'booked' rows are mutually exclusive by
--     instant, exactly matching the real invariant. This exists as
--     defense-in-depth alongside (not instead of) an application-layer
--     transaction + re-check in POST /bookings, at negligible cost (one
--     virtual column, computed on read/write, no extra storage for
--     non-matching rows since VIRTUAL columns aren't materialized).
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     every other table (this one legitimately is "the instant this row
--     was inserted" -- TIMESTAMP is correct here, unlike scheduled_at).
--
-- Security: holds no free text -- an id, a time, a duration, a status, a
-- room-id string, timestamps. Same host constraint as 0001-0008 applies:
-- ENCRYPTION='Y' intentionally NOT specified. See
-- server/migrations/README.md.
--
-- Indexing:
--   - idx_bookings_student_id_scheduled_at (student_id, scheduled_at):
--     serves "list this student's bookings in order" and satisfies
--     InnoDB's FK-indexing requirement for fk_bookings_student_id via its
--     leftmost column.
--   - idx_bookings_scheduled_at_status (scheduled_at, status): serves
--     every date/time-window query this table is read by that is NOT
--     scoped to one student -- the open-slots algorithm's "existing
--     bookings on this UTC calendar day" fetch, the dashboard's "upcoming
--     in next 24h across all students" query, and GET /bookings's
--     `upcoming=true` filter for an elle caller.
--   - uq_bookings_active_scheduled_at: see active_scheduled_at above.

CREATE TABLE bookings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id BIGINT UNSIGNED NOT NULL,
  scheduled_at DATETIME NOT NULL,
  duration_min TINYINT UNSIGNED NOT NULL DEFAULT 30,
  status ENUM('booked', 'completed', 'cancelled') NOT NULL DEFAULT 'booked',
  jitsi_room_id VARCHAR(36) NOT NULL,
  active_scheduled_at DATETIME
    GENERATED ALWAYS AS (CASE WHEN status = 'booked' THEN scheduled_at ELSE NULL END) VIRTUAL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bookings_student_id_scheduled_at (student_id, scheduled_at),
  KEY idx_bookings_scheduled_at_status (scheduled_at, status),
  UNIQUE KEY uq_bookings_active_scheduled_at (active_scheduled_at),
  CONSTRAINT fk_bookings_student_id
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS bookings;
