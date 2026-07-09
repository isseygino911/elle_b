// Shared timezone conversion helpers for the availability/open-slots model.
//
// `availability.day_of_week` / `start_time` / `end_time` represent
// America/New_York wall-clock time (Elle's own timezone), DST-aware --
// EST (UTC-5) in winter, EDT (UTC-4) in summer, transitioning on the
// standard US DST dates. `bookings.scheduled_at` is unaffected by this file
// and remains a precise UTC instant (see bookings.helpers.js's header
// comment). These two functions are the only place DST math happens; every
// other call site should go through them rather than re-deriving offsets.
//
// Deliberately dependency-free: uses only the native Intl API, which has
// full IANA tz database support (including DST transition dates) built in.

const TIME_ZONE = 'America/New_York';

// Returns the America/New_York UTC offset (in ms, e.g. -5h for EST,
// -4h for EDT) that is in effect at a given instant.
function easternOffsetMsAt(instant) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return asIfUtc - instant.getTime();
}

// Converts a wall-clock date+time AS IF it were experienced in
// America/New_York into the precise UTC Date it actually corresponds to,
// correctly accounting for whichever of EST (UTC-5) or EDT (UTC-4) is in
// effect on that specific date.
//
// Technique: treat the wall-clock digits as a naive UTC instant, look up
// the Eastern offset in effect there, and subtract it to get a first
// estimate of the real UTC instant. That estimate's own offset can differ
// from the naive guess's offset when the wall-clock time falls within the
// ~1 hour immediately after a DST transition (most concretely: the hour
// right after "spring forward", e.g. 3:00-3:59am EDT on transition day --
// its naive-UTC guess still lands before the transition instant, so the
// first pass looks up the old, wrong offset). Re-deriving the offset from
// the corrected estimate and re-applying it resolves this; DST shifts by
// exactly one hour at a time, so a second pass always converges (the sole
// remaining edge case, the literal invalid "spring forward gap" wall-clock
// hour, e.g. 2:30am on transition day, doesn't correspond to any real
// instant and isn't a value this app ever generates).
function easternWallClockToUtc(year, month, day, hour, minute) {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);

  const firstOffsetMs = easternOffsetMsAt(new Date(naiveUtc));
  const estimate = naiveUtc - firstOffsetMs;

  const secondOffsetMs = easternOffsetMsAt(new Date(estimate));
  const resolvedOffsetMs = secondOffsetMs !== firstOffsetMs ? secondOffsetMs : firstOffsetMs;

  return new Date(naiveUtc - resolvedOffsetMs);
}

// Returns { year, month, day, dayOfWeek } for the America/New_York calendar
// date that a given instant falls on (dayOfWeek: 0=Sunday..6=Saturday, same
// convention as availability.day_of_week and JS Date#getUTCDay()).
function getEasternDateParts(instant) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  });
  const parts = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    dayOfWeek: WEEKDAY_INDEX[parts.weekday]
  };
}

module.exports = { easternWallClockToUtc, getEasternDateParts };
