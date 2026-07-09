-- 0008_create_availability.sql
-- Creates the `availability` table (Phase 6 domain schema).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0007's
--     convention (no UUID overhead needed at this app's ~12-user scale).
--   - No owner/user_id column. This is a 1:1 tutor-student CRM with exactly
--     one 'elle' account (see 0001's users.role ENUM('elle','student') and
--     server/scripts/seed-elle.js) -- there is no marketplace concept of
--     multiple tutors each defining their own availability. Every row in
--     this table implicitly belongs to "the" elle account. Adding a
--     user_id FK here would be a column with exactly one possible value
--     forever, which is speculative infrastructure this app does not need
--     (see server/migrations/README.md's no-dead-column spirit). If this
--     app is ever extended to support more than one tutor, that is a
--     project-wide change (new FK on this table, plus role/authorization
--     changes throughout), not something to half-anticipate now.
--   - day_of_week: TINYINT UNSIGNED NOT NULL, values 0-6, where
--     0 = Sunday ... 6 = Saturday. This is JavaScript's
--     Date.prototype.getUTCDay() convention, NOT ISO-8601 (which numbers
--     Monday=1..Sunday=7). Deliberately picked because this column is
--     produced and consumed ONLY by this app's own Node/JS code (no
--     external calendar system, no ISO-8601 interchange requirement) --
--     the open-slots algorithm computes a candidate date's day-of-week via
--     `new Date(dateOnly + 'T00:00:00.000Z').getUTCDay()` and compares it
--     directly against this column with zero conversion. Using ISO-8601
--     numbering here would require a translation table at every read/write
--     site for no benefit -- exactly the kind of easy-to-get-wrong
--     off-by-one this comment exists to prevent. Do not "fix" this to
--     ISO-8601 without also rewriting every getUTCDay() call site.
--   - start_time / end_time: TIME NOT NULL. These are recurring weekly
--     wall-clock times, NOT tied to any specific calendar date -- "Mondays
--     09:00-17:00", forever, until this row is deleted. Both are stored as
--     UTC wall-clock time: e.g. start_time = '09:00:00' means 09:00 UTC on
--     every day_of_week this row matches, not 09:00 in any particular
--     local timezone. mysql2 returns TIME columns as plain strings
--     ("09:00:00"), not JS Date objects, so there is no local-timezone
--     Date-object reinterpretation risk here (contrast with DATE columns,
--     see tasks.helpers.js's formatDateOnly -- that pitfall does not apply
--     to TIME).
--   - chk_availability_time_order: CHECK (end_time > start_time) -- a
--     window with end <= start is nonsensical and would otherwise
--     silently generate zero candidate slots forever with no error
--     surfaced. MySQL 8.0.16+ enforces CHECK constraints (this project
--     targets MySQL 8 on Hostinger); this is defense-in-depth alongside
--     the same rule already enforced by availability.schema.js at the
--     application layer.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     every other table.
--
-- Security: holds no free text and no PII -- a day number and two times.
-- Same host constraint as 0001-0007 still applies: ENCRYPTION='Y'
-- intentionally NOT specified (Hostinger host has no keyring plugin). See
-- server/migrations/README.md.
--
-- Indexing:
--   - idx_availability_day_of_week (day_of_week): serves the only query
--     this table is ever read by -- "give me this day-of-week's windows"
--     inside the open-slots computation. No FK columns on this table, so
--     no FK-indexing requirement to satisfy.
--
-- Relationship to `bookings`: NONE at the schema level. There is
-- deliberately no FK between availability and bookings -- they are related
-- only through application-layer computation (the open-slots algorithm
-- reads both tables and reasons about overlap in JS; see
-- bookings.helpers.js). Deleting an availability window never touches
-- already-created bookings, and never should -- a booking, once made, is
-- an independent commitment regardless of whether the recurring rule that
-- originally permitted it still exists.

CREATE TABLE availability (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  day_of_week TINYINT UNSIGNED NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_availability_day_of_week (day_of_week),
  CONSTRAINT chk_availability_time_order CHECK (end_time > start_time)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS availability;
