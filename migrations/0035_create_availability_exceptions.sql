-- 0035_create_availability_exceptions.sql
-- Date-specific overrides on top of the RECURRING weekly `availability`
-- template (0008/0019).
--
-- WHY THIS TABLE EXISTS
-- `availability` is a pure weekly recurrence: (admin_id, day_of_week,
-- start_time, end_time), no dates, repeating forever. It has no vocabulary for
-- "not this Thursday, it's a holiday" or "I'll take an extra Saturday this one
-- time." Today the only way to express either is to edit or delete the
-- recurring rule -- which changes EVERY future week in order to fix one day,
-- and cannot be undone selectively. This table adds the missing dimension
-- without touching the recurrence: the weekly template stays the durable
-- statement of "normally", and each row here is a dated amendment to it.
--
-- RELATIONSHIP TO `bookings`: NONE AT THE SCHEMA LEVEL, DELIBERATELY.
-- Same posture 0008 already records for `availability`. There is no FK here to
-- bookings and no trigger. Inserting a 'block' NEVER cancels, deletes, or
-- otherwise mutates a booking -- it only narrows the set of slots that are
-- offered as OPEN going forward. A booking, once made, is an independent
-- commitment regardless of whether the rule that permitted it still exists.
-- Blocking a day on which a lesson is already booked leaves that lesson
-- booked, joinable, and visible in GET /bookings; the teacher must cancel it
-- explicitly if that is what they mean. Anyone tempted to add "blocking a day
-- cancels its lessons" must make that an explicit, separately-confirmed action
-- in the route -- never an implicit side effect of writing a row here.
--
-- ON `date` BEING DATE, NOT DATETIME
-- Follows assignments.due_date and tasks.due_date (see 0032's header). This is
-- an America/New_York CALENDAR DATE -- the same thing computeOpenSlots's
-- `date` parameter has always meant -- not an instant. Storing it as DATETIME
-- would drag in the whole dateStrings/toIsoUtcString discipline that 0009's
-- header describes, to represent a value that has no time-of-day.
--   IMPLEMENTATION REQUIREMENT, and it is the same class of bug as 0009's:
--   mysql2 returns DATE columns as JS Date objects, constructed by
--   reinterpreting "YYYY-MM-DD" against the client's LOCAL timezone. In
--   computeOpenSlotsRange this column is a GROUPING KEY, so a one-day shift
--   silently files every exception under the wrong day -- and it would pass in
--   a UTC container, then break the moment someone sets TZ. The range query
--   MUST therefore request `dateStrings: ['DATE', 'DATETIME']` so this column
--   arrives as the literal string MySQL holds. (Contrast tasks.helpers.js's
--   formatDateOnly, which solves the same problem for OUTPUT serialization by
--   reading local y/m/d off the Date; that is correct for a response body and
--   wrong for a join key, which should never round-trip through Date at all.)
--
-- ON start_time/end_time BEING NULLABLE
-- NULL/NULL on a 'block' means THE WHOLE DAY. This is the holiday case, and
-- it is the common one. Non-NULL means a partial-day block: "out Tuesday
-- morning, teaching Tuesday afternoon" -- which is the case that makes this
-- table worth building at all, because the alternative is deleting the
-- recurring Tuesday-morning window and losing every other Tuesday with it.
-- Two alternatives were considered and rejected:
--   - whole-day-only blocks: cannot express a partial day at all, so the
--     teacher's only recourse for a half-day absence is to mutate the
--     recurrence -- the exact failure this feature removes.
--   - NOT NULL with a 00:00:00-23:59:59 sentinel: a magic value every reader
--     must know, and one that does not actually cover the 23:30 slot's full
--     half hour under a strict overlap test. An almost-covering sentinel range
--     is a bug generator; NULL is the honest encoding of "no time bound".
-- An 'add' row must name both times: a whole-day 'add' has no defensible
-- meaning (midnight to midnight is not a teaching offer), and would generate
-- 48 candidate slots from a single accidental row.
--
-- NO UNIQUENESS CONSTRAINT, deliberately. Multiple 'block' rows on one date is
-- meaningful (two separate meetings), and overlapping blocks are idempotent
-- under set subtraction. A UNIQUE(admin_id, date, type) would forbid the
-- legitimate two-blocks-in-one-day case; adding start_time/end_time to that key
-- would forbid nothing interesting (NULL times are never equal in MySQL) while
-- adding a failure mode. Do not "tighten" this later.
--
-- ENGINE NOTE: MariaDB 11.8 in production. Each statement stands alone, per
-- the convention established in 0012/0017 (batched multi-clause ALTER TABLE
-- reproduces errno 121 here).
--
-- Security: holds no free text and no PII -- a date, an enum, two times, and a
-- teacher id. Same host constraint as everywhere else: ENCRYPTION='Y'
-- intentionally NOT specified (Hostinger host has no keyring plugin). See
-- migrations/README.md.

CREATE TABLE availability_exceptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- admin_id is the ONLY tenancy column, matching availability (0019). An
  -- exception is one specific teacher's dated amendment to their own weekly
  -- template; it is meaningless at the org level, and org_id would be
  -- derivable from the admin anyway. Every read of this table is per-teacher.
  admin_id BIGINT UNSIGNED NOT NULL,
  -- An America/New_York calendar date. See the note above.
  date DATE NOT NULL,
  -- 'block' removes offered time on this date; 'add' offers time on this date
  -- that the weekly template does not. Both are date-scoped and neither
  -- touches the recurrence.
  type ENUM('block', 'add') NOT NULL,
  -- NULL/NULL == whole day, and only ever on a 'block'. See the note above.
  start_time TIME NULL,
  end_time TIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Serves the ONLY query this table is read by:
  --     WHERE admin_id = ? AND date BETWEEN ? AND ?
  -- admin_id leads because it is always an equality predicate and date is
  -- always a range -- the range column must come last or it cannot be used to
  -- seek. This also satisfies InnoDB's FK-indexing requirement for
  -- fk_availability_exceptions_admin_id via its leftmost column, so no
  -- separate index is needed for the FK. Matches
  -- idx_availability_admin_id_day_of_week's reasoning in 0019 exactly.
  KEY idx_availability_exceptions_admin_id_date (admin_id, date),
  -- Both times present or both absent -- never one of the two, which would be
  -- an unbounded interval no reader could interpret. Named per-rule (rather
  -- than one combined CHECK) so a violation's constraint name states which
  -- rule broke; see 0032's header for why a wide multi-column CHECK is a poor
  -- error surface.
  CONSTRAINT chk_availability_exceptions_times_paired
    CHECK ((start_time IS NULL) = (end_time IS NULL)),
  -- Same rule, and same rationale, as chk_availability_time_order in 0008: a
  -- window with end <= start is nonsensical and would otherwise silently
  -- generate zero candidate slots (or block nothing) forever with no error
  -- surfaced. Defense-in-depth alongside availabilityExceptions.schema.js.
  CONSTRAINT chk_availability_exceptions_time_order
    CHECK (start_time IS NULL OR end_time > start_time),
  -- A whole-day 'add' has no meaning; see the note above.
  CONSTRAINT chk_availability_exceptions_add_has_times
    CHECK (type <> 'add' OR start_time IS NOT NULL),
  -- ON DELETE CASCADE, matching fk_availability_admin_id in 0019 and for the
  -- identical reason: an ownerless exception row is pure garbage, and unlike
  -- an orphaned student it is not recoverable by reassignment. Deleting a
  -- teacher deletes their schedule, recurrence and amendments alike.
  CONSTRAINT fk_availability_exceptions_admin_id
    FOREIGN KEY (admin_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- --- the index the range query needs on `bookings` -------------------------
-- computeOpenSlotsRange filters `admin_id = ? AND scheduled_at >= ? AND
-- scheduled_at < ?` over a span of up to 31 days.
--
-- 0021's header claims "the per-teacher queries are served by
-- uq_bookings_admin_id_active_scheduled_at's leading column". That is only
-- half true, and it is exactly the half this query needs: that index's second
-- column is the GENERATED `active_scheduled_at` (CASE WHEN status='booked'
-- THEN scheduled_at END), not `scheduled_at` itself, so the optimizer cannot
-- use it to seek a range over `scheduled_at` -- it seeks on admin_id and then
-- filters. At one-day width that is invisible. At 31-day width it becomes
-- "read every booking this teacher has ever had, filter in the server" on
-- every month-view page load -- the exact cost the range endpoint exists to
-- remove.
--
-- Added here, with the code that needs it, rather than deferred: splitting it
-- into 0036 would ship the range endpoint with a known table scan for however
-- long the two migrations are apart. It is a pure additive ADD KEY -- it
-- cannot fail on data, so no guard file (0018/0020-style) is warranted.
--
-- This does not disturb findOverlappingBooking: that path's correctness comes
-- from its transaction and FOR UPDATE row locks, not from which index the
-- optimizer picks.
ALTER TABLE bookings
  ADD KEY idx_bookings_admin_id_scheduled_at (admin_id, scheduled_at);

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE bookings DROP INDEX idx_bookings_admin_id_scheduled_at;
-- DROP TABLE IF EXISTS availability_exceptions;
