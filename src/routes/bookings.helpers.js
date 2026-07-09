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

const pool = require('../db/pool');
const { easternWallClockToUtc, getEasternDateParts } = require('../utils/timezone');

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
// connection — both expose `.query()` (see utils/elleUser.js's identical
// convention) — so POST /bookings can re-run this same computation inside
// its own transaction to re-check the requested slot is still open.
async function computeOpenSlots(executor, date) {
  const [year, month, day] = date.split('-').map(Number);

  // Day-of-week for a pure calendar date needs no timezone conversion --
  // only the actual instant-in-time (computed per-slot below) does.
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  // The Eastern calendar day's UTC boundaries. Re-derived via
  // easternWallClockToUtc (rather than a naive +24h) because a "day" in
  // Eastern local time is not always exactly 24 UTC hours long on the two
  // DST-transition days per year.
  const dayStartUtc = easternWallClockToUtc(year, month, day, 0, 0);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const dayEndUtc = easternWallClockToUtc(
    nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 0, 0
  );

  const [availabilityRows] = await executor.query(
    'SELECT start_time, end_time FROM availability WHERE day_of_week = ?',
    [dayOfWeek]
  );

  const [bookingRows] = await executor.query(
    {
      sql: "SELECT scheduled_at, duration_min FROM bookings WHERE status = 'booked' AND scheduled_at >= ? AND scheduled_at < ?",
      dateStrings: ['DATETIME']
    },
    [toMysqlDatetime(dayStartUtc.toISOString()), toMysqlDatetime(dayEndUtc.toISOString())]
  );

  const bookedIntervals = bookingRows.map((row) => {
    const start = new Date(toIsoUtcString(row.scheduled_at)).getTime();
    return { start, end: start + row.duration_min * 60000 };
  });

  const candidates = new Set();
  for (const window of availabilityRows) {
    const startMinutes = parseTimeToMinutes(window.start_time);
    const endMinutes = parseTimeToMinutes(window.end_time);
    for (let m = startMinutes; m <= endMinutes - SLOT_MINUTES; m += SLOT_MINUTES) {
      const instant = easternWallClockToUtc(year, month, day, Math.floor(m / 60), m % 60);
      candidates.add(instant.toISOString());
    }
  }

  const now = new Date();
  const nowEastern = getEasternDateParts(now);
  const isToday = nowEastern.year === year && nowEastern.month === month && nowEastern.day === day;

  const openSlots = [...candidates].filter((iso) => {
    const candidateStart = new Date(iso).getTime();
    const candidateEnd = candidateStart + SLOT_MINUTES * 60000;

    if (isToday && candidateStart < now.getTime()) {
      return false;
    }

    return !bookedIntervals.some(
      (booking) => candidateStart < booking.end && booking.start < candidateEnd
    );
  });

  openSlots.sort();
  return openSlots;
}

async function fetchScopedBookings(user, { status, upcoming, hoursAhead } = {}) {
  const conditions = [];
  const params = [];

  if (user.role === 'student') {
    conditions.push('b.student_id = ?');
    params.push(user.id);
  }

  if (status) {
    conditions.push('b.status = ?');
    params.push(status);
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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
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
  toMysqlDatetime,
  computeOpenSlots,
  fetchScopedBookings,
  serializeBooking
};
