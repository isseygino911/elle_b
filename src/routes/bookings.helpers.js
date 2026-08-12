// Shared by bookings.route.js and dashboard.route.js, so the role-scoping
// rule (elle sees all bookings, a student sees only their own) and the
// scheduled_at timezone-safe conversion logic each live in exactly one
// place.
//
// scheduled_at is a DATETIME column holding a UTC wall-clock value with no
// timezone awareness at the MySQL layer (see 0009_create_bookings.sql).
// mysql2 returns DATETIME columns as JS Date objects by default, constructed
// by reinterpreting the raw string against mysql2's own `timezone` client
// option (default 'local', not currently overridden in db/pool.js). Every
// query here that touches scheduled_at passes `dateStrings: ['DATETIME']`
// (scoped to just that column type, so TIMESTAMP columns like created_at
// are untouched and keep behaving exactly as they do everywhere else in the
// app) so scheduled_at always comes back as the exact raw string MySQL
// holds, with zero local-timezone reinterpretation.
//
// THE SAME RULE APPLIES TO **DATE** COLUMNS, NOT JUST DATETIME.
// availability_exceptions.date (migration 0035) is a DATE, and mysql2
// reinterprets DATE against the client's local timezone in exactly the same
// way. In computeOpenSlotsRange that column is a GROUPING KEY, so a one-day
// shift silently files every exception under the wrong day -- and it would
// pass in a UTC container, then break the moment someone sets TZ. The
// exceptions query below therefore passes `dateStrings: ['DATE', 'DATETIME']`.
// Do not read "DATETIME" above as the complete rule: any future query here
// that selects a DATE column must include 'DATE' too.
//   (Contrast tasks.helpers.js's formatDateOnly, which solves the same problem
//   for OUTPUT serialization by reading local y/m/d off the Date. That is
//   correct for a response body and wrong for a join key, which should never
//   round-trip through Date at all.)

const pool = require('../db/pool');
const { easternWallClockToUtc, getEasternDateParts } = require('../utils/timezone');
const { scopeFor } = require('../utils/scope');

const SLOT_MINUTES = 30;

// How early before scheduled_at, and how long after scheduled_at + duration,
// a 'booked' session's Jitsi room is considered joinable. See isJoinable.
const JOIN_WINDOW_BEFORE_MIN = 10;
const JOIN_WINDOW_AFTER_GRACE_MIN = 15;

// "2026-07-10T09:00:00.000Z" -> "2026-07-10 09:00:00"
function toMysqlDatetime(isoUtcString) {
  const d = new Date(isoUtcString);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const seconds = String(d.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// "2026-07-10 09:00:00" -> "2026-07-10T09:00:00.000Z"
function toIsoUtcString(mysqlDatetimeString) {
  return `${mysqlDatetimeString.replace(' ', 'T')}.000Z`;
}

function parseTimeToMinutes(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number);
  return hours * 60 + minutes;
}

// Computes the open (bookable) 30-minute slots for a given America/New_York
// calendar date (Elle's own timezone -- see utils/timezone.js), against
// this app's recurring weekly availability windows (also interpreted as
// America/New_York wall-clock time) minus any already-'booked' bookings
// and any already-past slots (if date is the current Eastern calendar
// date). `executor` is either the shared pool or an open transaction
// connection — both expose `.query()` (see utils/counterparty.js's identical
// convention) — so POST /bookings can re-run this same computation inside
// its own transaction to re-check the requested slot is still open.
// `adminId` is REQUIRED: it identifies whose calendar is being computed. It
// was absent under the single-teacher model, when "the availability table"
// and "the bookings table" each belonged to the only teacher there was. With
// several teachers, omitting it would union every teacher's availability and
// subtract every teacher's bookings -- so teacher A's 09:00 session would
// silently erase 09:00 from teacher B's open slots, and each teacher would be
// offered the others' hours.
// Iterates Eastern calendar dates from `fromDate` to `toDate` INCLUSIVE,
// yielding "YYYY-MM-DD" strings.
//
// Steps via Date.UTC on the date COMPONENTS only -- a pure calendar walk with
// no timezone semantics, exactly like the dayOfWeek derivation below. Stepping
// an actual instant by 86_400_000 ms would drift by an hour across each DST
// transition and eventually repeat or skip a day outright.
function* easternDateRange(fromDate, toDate) {
  const [fromYear, fromMonth, fromDay] = fromDate.split('-').map(Number);
  const [toYear, toMonth, toDay] = toDate.split('-').map(Number);

  const last = Date.UTC(toYear, toMonth - 1, toDay);
  let cursor = Date.UTC(fromYear, fromMonth - 1, fromDay);

  while (cursor <= last) {
    yield new Date(cursor).toISOString().slice(0, 10);
    const d = new Date(cursor);
    cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
}

// The per-day merge. PURE -- takes already-fetched data and does no I/O, which
// is what lets ONE set of queries serve 31 days, and what makes the merge
// semantics testable without a database.
//
// Order of operations is load-bearing:
//   1. recurring windows  -> candidates
//   2. 'add' exceptions   -> candidates  (a Set, so overlap is idempotent)
//   3. 'block' exceptions -> removed
//   4. bookings           -> removed
//   5. past slots         -> removed, ONLY when this date is today in Eastern
//
// Step 2 MUST precede step 4. An 'add' on a day with no recurring window can
// otherwise manufacture a slot that collides with a booking made long ago
// under a since-deleted rule, and re-offer an instant that is already taken.
//
// Steps 3-5 are all removals, so they collapse into one filter pass and are
// order-independent among themselves. 'block' therefore beats 'add' -- stated
// explicitly because the opposite convention (an 'add' re-opening blocked
// time) is equally imaginable and someone will eventually ask. Subtraction
// last is the safer default: it fails toward offering too little, which the
// teacher can fix by deleting the block, rather than toward offering time the
// teacher is unavailable for, which is a real double-booking.
function computeDayOpenSlots({ date, windowsByDow, exceptionsByDate, bookedIntervals, now, nowEastern }) {
  const [year, month, day] = date.split('-').map(Number);

  // Day-of-week for a pure calendar date needs no timezone conversion --
  // only the actual instant-in-time (computed per-slot below) does.
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const exceptions = exceptionsByDate.get(date) || [];

  const candidates = new Set();

  function addWindow(startMinutes, endMinutes) {
    for (let m = startMinutes; m <= endMinutes - SLOT_MINUTES; m += SLOT_MINUTES) {
      const instant = easternWallClockToUtc(year, month, day, Math.floor(m / 60), m % 60);
      candidates.add(instant.toISOString());
    }
  }

  for (const window of windowsByDow.get(dayOfWeek) || []) {
    addWindow(parseTimeToMinutes(window.start_time), parseTimeToMinutes(window.end_time));
  }

  for (const exception of exceptions) {
    if (exception.type === 'add') {
      addWindow(parseTimeToMinutes(exception.start_time), parseTimeToMinutes(exception.end_time));
    }
  }

  // The Eastern calendar day's UTC boundaries. Re-derived via
  // easternWallClockToUtc (rather than a naive +24h) because a "day" in
  // Eastern local time is not always exactly 24 UTC hours long on the two
  // DST-transition days per year -- so a whole-day block built on +24h would
  // leave the final hour of the 25-hour November day unblocked.
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const blockedIntervals = [];
  for (const exception of exceptions) {
    if (exception.type !== 'block') {
      continue;
    }

    if (exception.start_time === null) {
      blockedIntervals.push({
        start: easternWallClockToUtc(year, month, day, 0, 0).getTime(),
        end: easternWallClockToUtc(
          nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0
        ).getTime()
      });
      continue;
    }

    const startMinutes = parseTimeToMinutes(exception.start_time);
    const endMinutes = parseTimeToMinutes(exception.end_time);
    blockedIntervals.push({
      start: easternWallClockToUtc(year, month, day, Math.floor(startMinutes / 60), startMinutes % 60).getTime(),
      end: easternWallClockToUtc(year, month, day, Math.floor(endMinutes / 60), endMinutes % 60).getTime()
    });
  }

  const isToday = nowEastern.year === year && nowEastern.month === month && nowEastern.day === day;

  const openSlots = [...candidates].filter((iso) => {
    const candidateStart = new Date(iso).getTime();
    const candidateEnd = candidateStart + SLOT_MINUTES * 60000;

    // Only filters on the date that is TODAY in Eastern terms. A strictly-past
    // date returns its full candidate set, which is the behavior this function
    // has always had; changing it is a separate decision, not a side effect of
    // this refactor.
    if (isToday && candidateStart < now.getTime()) {
      return false;
    }

    // Standard half-open overlap, the same test used for bookings: a block
    // removes every slot it TOUCHES, even partially. At 30-minute granularity
    // a slot is bookable as a full half hour or not at all, so offering one the
    // teacher is unavailable for half of would produce a real double-booking.
    if (
      blockedIntervals.some(
        (blocked) => candidateStart < blocked.end && blocked.start < candidateEnd
      )
    ) {
      return false;
    }

    return !bookedIntervals.some(
      (booking) => candidateStart < booking.end && booking.start < candidateEnd
    );
  });

  openSlots.sort();
  return openSlots;
}

// Computes open slots for every Eastern calendar date in [fromDate, toDate],
// using a CONSTANT three queries regardless of how wide the span is. The month
// view needs ~30 days; doing that as 30 single-day calls would be ~90 queries.
//
// Returns { "YYYY-MM-DD": [isoUtcString, ...] } with EVERY date in the range
// present, including days with no open slots (empty array), so a month grid
// never has to distinguish "no availability" from "day missing from the
// response".
async function computeOpenSlotsRange(executor, fromDate, toDate, adminId) {
  if (!adminId) {
    throw new Error('computeOpenSlotsRange requires an adminId');
  }

  // --- QUERY 1: every weekday's windows for this teacher, once. -------------
  // No day_of_week predicate: a range spans up to 31 days and therefore every
  // weekday, so filtering would only complicate the grouping. A teacher has a
  // handful of rows here; the index's leading column still serves it.
  const [availabilityRows] = await executor.query(
    'SELECT day_of_week, start_time, end_time FROM availability WHERE admin_id = ?',
    [adminId]
  );

  const windowsByDow = new Map();
  for (const row of availabilityRows) {
    const existing = windowsByDow.get(row.day_of_week);
    if (existing) {
      existing.push(row);
    } else {
      windowsByDow.set(row.day_of_week, [row]);
    }
  }

  // --- QUERY 2: exceptions across the whole span, once. ---------------------
  // dateStrings includes 'DATE' -- see this file's header. `date` is a
  // grouping key here, and a Date object would be reinterpreted in local time
  // and shift the entire map by a day on any server not running UTC.
  const [exceptionRows] = await executor.query(
    {
      sql: 'SELECT date, type, start_time, end_time FROM availability_exceptions WHERE admin_id = ? AND date BETWEEN ? AND ?',
      dateStrings: ['DATE', 'DATETIME']
    },
    [adminId, fromDate, toDate]
  );

  const exceptionsByDate = new Map();
  for (const row of exceptionRows) {
    const existing = exceptionsByDate.get(row.date);
    if (existing) {
      existing.push(row);
    } else {
      exceptionsByDate.set(row.date, [row]);
    }
  }

  // --- QUERY 3: bookings across the whole span, once. -----------------------
  // Bounds are the DST-correct UTC instants of the first day's Eastern
  // midnight and the day-after-last's Eastern midnight.
  //
  // The lower bound is widened by one day so a booking that STARTS before the
  // range but runs into it (a long session across Eastern midnight) is still
  // subtracted. Bookings are matched by instant overlap, so they need no
  // per-day bucketing -- and bucketing them would risk mis-filing exactly that
  // straddling session.
  const [fromYear, fromMonth, fromDay] = fromDate.split('-').map(Number);
  const [toYear, toMonth, toDay] = toDate.split('-').map(Number);
  const rangeStart = new Date(Date.UTC(fromYear, fromMonth - 1, fromDay - 1));
  const rangeEnd = new Date(Date.UTC(toYear, toMonth - 1, toDay + 1));

  const rangeStartUtc = easternWallClockToUtc(
    rangeStart.getUTCFullYear(), rangeStart.getUTCMonth() + 1, rangeStart.getUTCDate(), 0, 0
  );
  const rangeEndUtc = easternWallClockToUtc(
    rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth() + 1, rangeEnd.getUTCDate(), 0, 0
  );

  const [bookingRows] = await executor.query(
    {
      sql: "SELECT scheduled_at, duration_min FROM bookings WHERE admin_id = ? AND status = 'booked' AND scheduled_at >= ? AND scheduled_at < ?",
      dateStrings: ['DATETIME']
    },
    [adminId, toMysqlDatetime(rangeStartUtc.toISOString()), toMysqlDatetime(rangeEndUtc.toISOString())]
  );

  const bookedIntervals = bookingRows.map((row) => {
    const start = new Date(toIsoUtcString(row.scheduled_at)).getTime();
    return { start, end: start + row.duration_min * 60000 };
  });

  // Captured once for the whole range rather than per day: a 31-day loop
  // calling new Date() per iteration could straddle a minute boundary and
  // produce a slot set that is not internally consistent.
  const now = new Date();
  const nowEastern = getEasternDateParts(now);

  const slotsByDate = {};
  for (const date of easternDateRange(fromDate, toDate)) {
    slotsByDate[date] = computeDayOpenSlots({
      date, windowsByDow, exceptionsByDate, bookedIntervals, now, nowEastern
    });
  }

  return slotsByDate;
}

// Single-day open slots. Signature and behavior UNCHANGED: POST /bookings
// calls this inside its own transaction, passing the open connection as
// `executor`, and compares the result to a client-supplied instant with
// `.includes()` -- so the return value must stay a sorted Array<string> of
// canonical "...000Z" instants, and the adminId guard must stay here so its
// error message does not change.
//
// Delegating rather than duplicating is the point: two copies of "what open
// means" would drift the moment exceptions gain a third type, and the copy
// that drifted would be the one guarding the INSERT.
async function computeOpenSlots(executor, date, adminId) {
  if (!adminId) {
    throw new Error('computeOpenSlots requires an adminId');
  }

  const slotsByDate = await computeOpenSlotsRange(executor, date, date, adminId);
  return slotsByDate[date];
}

// Detects whether a proposed booking OVERLAPS an existing one on the same
// teacher's calendar.
//
// The uq_bookings_admin_id_active_scheduled_at unique index (migration 0021)
// only catches bookings that share an EXACT start instant. It cannot express
// interval overlap: a 60-minute session at 09:00 and a 30-minute session at
// 09:30 have different scheduled_at values, satisfy the index, and still
// collide in reality. No unique index can express this -- it has to be a
// query.
//
// MUST be called inside the same transaction as the INSERT, with FOR UPDATE,
// so two simultaneous requests cannot both pass this check before either
// inserts. FOR UPDATE makes the second request block until the first commits,
// at which point it sees the new row.
//
// Standard half-open interval overlap: newStart < existingEnd AND existingStart < newEnd.
async function findOverlappingBooking(connection, { adminId, startIsoUtc, durationMin }) {
  const startUtc = toMysqlDatetime(startIsoUtc);
  const endUtc = toMysqlDatetime(
    new Date(new Date(startIsoUtc).getTime() + durationMin * 60000).toISOString()
  );

  const [rows] = await connection.query(
    {
      sql: `SELECT id, scheduled_at, duration_min
              FROM bookings
             WHERE admin_id = ?
               AND status = 'booked'
               AND scheduled_at < ?
               AND DATE_ADD(scheduled_at, INTERVAL duration_min MINUTE) > ?
             LIMIT 1
             FOR UPDATE`,
      dateStrings: ['DATETIME']
    },
    [adminId, endUtc, startUtc]
  );

  return rows[0] || null;
}

async function fetchScopedBookings(user, { status, upcoming, hoursAhead, studentId } = {}) {
  // Column names are qualified with the `b` alias used by the query below.
  // An admin sees only bookings on their own calendar; an owner sees every
  // booking in their organization; a student sees only their own. A manager
  // is rejected by scopeFor -- bookings are per-student detail, not aggregate
  // data.
  //
  // Previously this scoped negatively ("if student, filter; otherwise return
  // every booking in the table"), which would have shown one teacher every
  // other teacher's calendar. See utils/scope.js.
  const scope = scopeFor(user, {
    org: 'b.org_id',
    admin: 'b.admin_id',
    student: 'b.student_id'
  });

  const conditions = [scope.sql];
  const params = [...scope.params];

  if (status) {
    conditions.push('b.status = ?');
    params.push(status);
  }

  // Narrows to one student, for GET /students/:id/detail. ADDITIVE to the
  // tenancy predicate above, never a replacement for it: an admin passing
  // another teacher's student id still matches nothing, because scope.sql
  // already pins b.admin_id to them. The caller's right to see this student is
  // established separately by assertStudentInScope.
  if (studentId) {
    conditions.push('b.student_id = ?');
    params.push(studentId);
  }

  if (upcoming) {
    const now = new Date();
    conditions.push('b.scheduled_at >= ?');
    params.push(toMysqlDatetime(now.toISOString()));

    if (hoursAhead) {
      const until = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
      conditions.push('b.scheduled_at < ?');
      params.push(toMysqlDatetime(until.toISOString()));
    }
  }

  // `conditions` always holds at least the tenancy predicate, so the
  // "no WHERE clause at all" case that produced an unscoped query cannot occur.
  const where = `WHERE ${conditions.join(' AND ')}`;
  const [rows] = await pool.query(
    {
      sql: `SELECT b.*, u.name AS student_name
            FROM bookings b
            JOIN users u ON u.id = b.student_id
            ${where}
            ORDER BY b.scheduled_at ASC`,
      dateStrings: ['DATETIME']
    },
    params
  );
  return rows;
}

// Whether a 'booked' session's Jitsi room should be enterable right now:
// from JOIN_WINDOW_BEFORE_MIN minutes before scheduled_at through
// JOIN_WINDOW_AFTER_GRACE_MIN minutes after the session's scheduled end.
// Always computed fresh against `now` -- never stored, never trusted from
// a cached value -- so the result is correct no matter when it's called.
function isJoinable(scheduledAtIso, durationMin, status, now = new Date()) {
  if (status !== 'booked') return false;

  const scheduledAt = new Date(scheduledAtIso);
  const windowStart = new Date(scheduledAt.getTime() - JOIN_WINDOW_BEFORE_MIN * 60000);
  const windowEnd = new Date(scheduledAt.getTime() + (durationMin + JOIN_WINDOW_AFTER_GRACE_MIN) * 60000);

  return now >= windowStart && now <= windowEnd;
}

// Shapes a `bookings` row (joined with the student's users row) for API
// responses.
function serializeBooking(row) {
  const scheduledAtIso = toIsoUtcString(row.scheduled_at);

  return {
    id: row.id,
    student_id: row.student_id,
    student_name: row.student_name,
    scheduled_at: scheduledAtIso,
    duration_min: row.duration_min,
    status: row.status,
    jitsi_room_id: row.jitsi_room_id,
    joinable: isJoinable(scheduledAtIso, row.duration_min, row.status),
    created_at: row.created_at
  };
}

module.exports = {
  findOverlappingBooking,
  toMysqlDatetime,
  computeOpenSlots,
  computeOpenSlotsRange,
  fetchScopedBookings,
  serializeBooking
};
