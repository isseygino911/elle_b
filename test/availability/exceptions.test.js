'use strict';

// Phase 3 -- dated availability exceptions.
//
// `availability` is a RECURRING weekly template with no dates. This suite
// covers the new `availability_exceptions` table that amends it per-date, and
// the range endpoint the month view needs.
//
// The boundaries asserted here are the ones the plan lists as must-not-regress:
//
//   1. A block NEVER cancels a booking. Asserted on the raw SQL row, not the
//      API -- an API-only assertion passes against a soft-delete.
//   2. An 'add' cannot re-open an already-booked instant (adds must be folded
//      into the candidate set BEFORE bookings are subtracted).
//   3. A manager is refused on every endpoint. They outrank a teacher who is
//      allowed, so any rank-based gate passes them -- the canonical
//      wrong-check test.
//   4. A teacher cannot read, edit, or delete another teacher's exceptions,
//      and the row is still present in SQL afterward.
//   5. The range endpoint issues a CONSTANT number of queries regardless of
//      span -- the N+1 it exists to remove cannot silently come back.
//
// EQUIVALENCE ANCHORS (tests 15 and 34 in the plan) were written BEFORE the
// computeOpenSlots -> computeOpenSlotsRange refactor and must stay green
// through it. They are what pin the claim that the refactor changed no
// behavior. If either fails, the refactor regressed the endpoint that guards
// POST /bookings.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { get, post, patch, del } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');
const { MAX_RANGE_DAYS } = require('../../src/schemas/bookings.schema');

const { ctx } = useTestDatabase();

// 2026-08-11 is a Tuesday (day_of_week = 2). Fixed dates throughout, never
// relative to now, so these tests do not rot.
const TUESDAY = '2026-08-11';
const TUESDAY_DOW = 2;

async function exceptionRows() {
  const [rows] = await ctx.pool.query(
    'SELECT * FROM availability_exceptions ORDER BY id ASC'
  );
  return rows;
}

async function bookingRows() {
  const [rows] = await ctx.pool.query({
    sql: 'SELECT * FROM bookings ORDER BY id ASC',
    dateStrings: ['DATETIME']
  });
  return rows;
}

// Creates a recurring window through the real API, since that is the path a
// teacher actually uses.
async function seedWindow(teacher, dayOfWeek, startTime, endTime) {
  const res = await post('/availability', {
    token: tokenFor(teacher),
    body: { day_of_week: dayOfWeek, start_time: startTime, end_time: endTime }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.availability;
}

// Inserts a booking directly rather than through POST /bookings: several tests
// need a booking at an instant that is deliberately NOT open, which the real
// endpoint would (correctly) refuse.
async function seedBooking(teacher, student, mysqlUtcDatetime, durationMin = 30) {
  const [result] = await ctx.pool.query(
    `INSERT INTO bookings (org_id, admin_id, student_id, scheduled_at, duration_min, status, jitsi_room_id)
     VALUES (?, ?, ?, ?, ?, 'booked', ?)`,
    [
      teacher.orgId,
      teacher.id,
      student.id,
      mysqlUtcDatetime,
      durationMin,
      `room-${Math.abs(mysqlUtcDatetime.length * 7919)}-${student.id}`
    ]
  );
  return result.insertId;
}

async function openSlots(user, date, query = '') {
  const res = await get(`/bookings/open-slots?date=${date}${query}`, {
    token: tokenFor(user)
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.slots;
}

// ---------------------------------------------------------------------------
// EQUIVALENCE ANCHORS -- written before the refactor, must survive it.
// ---------------------------------------------------------------------------

test('ANCHOR: with no exceptions, open slots are exactly the recurring windows', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '11:00');

  const slots = await openSlots(orgA.teacher1, TUESDAY);

  // 09:00 EDT = 13:00Z in August (UTC-4).
  assert.deepEqual(slots, [
    '2026-08-11T13:00:00.000Z',
    '2026-08-11T13:30:00.000Z',
    '2026-08-11T14:00:00.000Z',
    '2026-08-11T14:30:00.000Z'
  ]);
});

test('ANCHOR: a range of one day equals the single-day endpoint exactly', async () => {
  const { orgA } = ctx.fixtures;
  // Exercise all four code paths at once: a recurring window, a partial block,
  // an add, and a booking -- so the comparison covers every branch of the
  // merge, not just the trivial one.
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '12:00');
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block', start_time: '10:00', end_time: '10:30' }
  });
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'add', start_time: '15:00', end_time: '16:00' }
  });
  await seedBooking(orgA.teacher1, orgA.student1a, '2026-08-11 13:30:00');

  const single = await openSlots(orgA.teacher1, TUESDAY);

  const ranged = await get(`/bookings/open-slots-range?from=${TUESDAY}&to=${TUESDAY}`, {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(ranged.status, 200, JSON.stringify(ranged.body));

  assert.deepStrictEqual(ranged.body.slots_by_date[TUESDAY], single);
  // And the merge actually did something -- otherwise this asserts equality of
  // two empty arrays and proves nothing.
  assert.ok(single.length > 0, 'expected a non-trivial slot set');
});

// ---------------------------------------------------------------------------
// A. Migration & schema
// ---------------------------------------------------------------------------

test('availability_exceptions is indexed (admin_id, date) in that order', async () => {
  const [rows] = await ctx.pool.query(
    `SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'availability_exceptions'
        AND INDEX_NAME = 'idx_availability_exceptions_admin_id_date'
      ORDER BY SEQ_IN_INDEX ASC`
  );
  // Order is load-bearing: date is always a range predicate, so it must come
  // last or the index cannot be used to seek. A reversed index still returns
  // correct rows, so nothing else in this suite would catch it.
  assert.deepEqual(
    rows.map((r) => r.COLUMN_NAME),
    ['admin_id', 'date']
  );
});

test('bookings gained the (admin_id, scheduled_at) index the range query needs', async () => {
  const [rows] = await ctx.pool.query(
    `SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'bookings'
        AND INDEX_NAME = 'idx_bookings_admin_id_scheduled_at'
      ORDER BY SEQ_IN_INDEX ASC`
  );
  assert.deepEqual(
    rows.map((r) => r.COLUMN_NAME),
    ['admin_id', 'scheduled_at']
  );
});

test('the CHECK constraints reject malformed rows at the DB layer', async () => {
  const { orgA } = ctx.fixtures;

  // Unpaired times.
  await assert.rejects(
    ctx.pool.query(
      "INSERT INTO availability_exceptions (admin_id, date, type, start_time, end_time) VALUES (?, ?, 'block', '10:00', NULL)",
      [orgA.teacher1.id, TUESDAY]
    )
  );

  // end <= start.
  await assert.rejects(
    ctx.pool.query(
      "INSERT INTO availability_exceptions (admin_id, date, type, start_time, end_time) VALUES (?, ?, 'block', '11:00', '10:00')",
      [orgA.teacher1.id, TUESDAY]
    )
  );

  // Whole-day 'add'.
  await assert.rejects(
    ctx.pool.query(
      "INSERT INTO availability_exceptions (admin_id, date, type, start_time, end_time) VALUES (?, ?, 'add', NULL, NULL)",
      [orgA.teacher1.id, TUESDAY]
    )
  );
});

// ---------------------------------------------------------------------------
// B. CRUD & authorization
// ---------------------------------------------------------------------------

test('a teacher creates a whole-day block', async () => {
  const { orgA } = ctx.fixtures;
  const res = await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block' }
  });

  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.exception.type, 'block');
  assert.equal(res.body.exception.start_time, null);
  assert.equal(res.body.exception.end_time, null);

  const rows = await exceptionRows();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].admin_id), String(orgA.teacher1.id));
});

test('the date round-trips exactly through POST, GET and SQL', async () => {
  const { orgA } = ctx.fixtures;
  // The canary for the mysql2 DATE-in-local-timezone trap: a naive
  // toISOString() serializer shifts this by a day on any server east of UTC.
  const created = await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: '2026-08-10', type: 'block' }
  });
  assert.equal(created.body.exception.date, '2026-08-10', JSON.stringify(created.body));

  const listed = await get('/availability-exceptions', { token: tokenFor(orgA.teacher1) });
  assert.equal(listed.body.exceptions[0].date, '2026-08-10', JSON.stringify(listed.body));

  const [rows] = await ctx.pool.query(
    "SELECT DATE_FORMAT(date, '%Y-%m-%d') AS d FROM availability_exceptions"
  );
  assert.equal(rows[0].d, '2026-08-10');
});

test('zod rejects malformed exception bodies', async () => {
  const { orgA } = ctx.fixtures;
  const token = tokenFor(orgA.teacher1);

  const bad = [
    { date: TUESDAY, type: 'block', start_time: '10:00' }, // unpaired
    { date: TUESDAY, type: 'block', start_time: '11:00', end_time: '10:00' }, // reversed
    { date: TUESDAY, type: 'block', start_time: '10:00', end_time: '10:00:00' }, // equal, HH:MM vs HH:MM:SS
    { date: TUESDAY, type: 'add' }, // whole-day add
    { date: TUESDAY, type: 'blocked' }, // bad enum
    { date: '2026-8-1', type: 'block' } // bad date shape
  ];

  for (const body of bad) {
    const res = await post('/availability-exceptions', { token, body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('a teacher cannot see, edit or delete another teacher\'s exceptions', async () => {
  const { orgA } = ctx.fixtures;
  const created = await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher2),
    body: { date: TUESDAY, type: 'block' }
  });
  const id = created.body.exception.id;

  const listed = await get('/availability-exceptions', { token: tokenFor(orgA.teacher1) });
  assert.equal(listed.body.exceptions.length, 0, JSON.stringify(listed.body));

  const patched = await patch(`/availability-exceptions/${id}`, {
    token: tokenFor(orgA.teacher1),
    body: { date: '2026-08-12', type: 'block' }
  });
  assert.equal(patched.status, 404, JSON.stringify(patched.body));

  const deleted = await del(`/availability-exceptions/${id}`, {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(deleted.status, 404, JSON.stringify(deleted.body));

  // The row must still be there -- a 404 that actually deleted would pass the
  // status assertions above.
  const rows = await exceptionRows();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].date.getFullYear?.() ?? ''), '2026');
});

test('a manager and a student are refused on every exceptions endpoint', async () => {
  const { orgA } = ctx.fixtures;
  const created = await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block' }
  });
  const id = created.body.exception.id;

  for (const user of [orgA.manager, orgA.student1a]) {
    const token = tokenFor(user);
    assert.equal((await get('/availability-exceptions', { token })).status, 403);
    assert.equal(
      (await post('/availability-exceptions', { token, body: { date: TUESDAY, type: 'block' } }))
        .status,
      403
    );
    assert.equal(
      (await patch(`/availability-exceptions/${id}`, { token, body: { date: TUESDAY, type: 'block' } }))
        .status,
      403
    );
    assert.equal((await del(`/availability-exceptions/${id}`, { token })).status, 403);
  }
});

test('an owner must name a teacher, and only one in their own org', async () => {
  const { orgA, orgB } = ctx.fixtures;
  const token = tokenFor(orgA.owner);

  const missing = await post('/availability-exceptions', {
    token,
    body: { date: TUESDAY, type: 'block' }
  });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));

  const crossOrg = await post('/availability-exceptions', {
    token,
    body: { date: TUESDAY, type: 'block', admin_id: orgB.teacher.id }
  });
  assert.equal(crossOrg.status, 400, JSON.stringify(crossOrg.body));

  // admin_id must survive zod's unknown-key stripping for this to work.
  const ok = await post('/availability-exceptions', {
    token,
    body: { date: TUESDAY, type: 'block', admin_id: orgA.teacher1.id }
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  const rows = await exceptionRows();
  assert.equal(String(rows[0].admin_id), String(orgA.teacher1.id));
});

// ---------------------------------------------------------------------------
// C. Merge semantics
// ---------------------------------------------------------------------------

test('a whole-day block empties the day', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '12:00');
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block' }
  });

  assert.deepEqual(await openSlots(orgA.teacher1, TUESDAY), []);
});

test('a partial block splits a window into two runs', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '12:00');
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block', start_time: '10:00', end_time: '11:00' }
  });

  assert.deepEqual(await openSlots(orgA.teacher1, TUESDAY), [
    '2026-08-11T13:00:00.000Z', // 09:00
    '2026-08-11T13:30:00.000Z', // 09:30
    '2026-08-11T15:00:00.000Z', // 11:00
    '2026-08-11T15:30:00.000Z' // 11:30
  ]);
});

test('a block removes every slot it touches, even partially', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '11:00');
  // 10:15-10:45 straddles both the 10:00 and 10:30 slots.
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block', start_time: '10:15', end_time: '10:45' }
  });

  assert.deepEqual(await openSlots(orgA.teacher1, TUESDAY), [
    '2026-08-11T13:00:00.000Z',
    '2026-08-11T13:30:00.000Z'
  ]);
});

test('block boundaries are half-open', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '10:30');
  // Exactly the 09:00 slot; must not touch 09:30.
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block', start_time: '09:00', end_time: '09:30' }
  });

  assert.deepEqual(await openSlots(orgA.teacher1, TUESDAY), [
    '2026-08-11T13:30:00.000Z',
    '2026-08-11T14:00:00.000Z'
  ]);
});

test('a block ending exactly at a window start removes nothing', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '10:00');
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block', start_time: '08:00', end_time: '09:00' }
  });

  assert.deepEqual(await openSlots(orgA.teacher1, TUESDAY), [
    '2026-08-11T13:00:00.000Z',
    '2026-08-11T13:30:00.000Z'
  ]);
});

test('an add creates slots on a day with no recurring window', async () => {
  const { orgA } = ctx.fixtures;
  // No window seeded at all for Tuesday.
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'add', start_time: '14:00', end_time: '15:00' }
  });

  assert.deepEqual(await openSlots(orgA.teacher1, TUESDAY), [
    '2026-08-11T18:00:00.000Z',
    '2026-08-11T18:30:00.000Z'
  ]);
});

test('an add overlapping a recurring window produces no duplicate slots', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '11:00');
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'add', start_time: '10:00', end_time: '12:00' }
  });

  const slots = await openSlots(orgA.teacher1, TUESDAY);
  assert.equal(new Set(slots).size, slots.length, 'duplicate slots leaked');
  assert.equal(slots.length, 6); // 09:00..11:30
});

test('block beats add when they overlap', async () => {
  const { orgA } = ctx.fixtures;
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'add', start_time: '14:00', end_time: '16:00' }
  });
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block', start_time: '15:00', end_time: '16:00' }
  });

  assert.deepEqual(await openSlots(orgA.teacher1, TUESDAY), [
    '2026-08-11T18:00:00.000Z', // 14:00
    '2026-08-11T18:30:00.000Z' // 14:30
  ]);
});

test('one teacher\'s exception does not affect another\'s slots', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '10:00');
  await seedWindow(orgA.teacher2, TUESDAY_DOW, '09:00', '10:00');
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher2),
    body: { date: TUESDAY, type: 'block' }
  });

  assert.equal((await openSlots(orgA.teacher1, TUESDAY)).length, 2);
  assert.equal((await openSlots(orgA.teacher2, TUESDAY)).length, 0);
});

// ---------------------------------------------------------------------------
// D. Block vs booking -- the must-not-regress set
// ---------------------------------------------------------------------------

test('blocking a day does NOT cancel a booking on it', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '11:00');
  const bookingId = await seedBooking(orgA.teacher1, orgA.student1a, '2026-08-11 13:00:00');

  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block' }
  });

  // Assert on the raw SQL row: an API-only check would pass against a
  // soft-delete or a status flip.
  const rows = await bookingRows();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].id), String(bookingId));
  assert.equal(rows[0].status, 'booked');
  assert.equal(rows[0].scheduled_at, '2026-08-11 13:00:00');

  const listed = await get('/bookings', { token: tokenFor(orgA.teacher1) });
  assert.equal(listed.body.bookings.length, 1, JSON.stringify(listed.body));

  // And the day still reports no open slots.
  assert.deepEqual(await openSlots(orgA.teacher1, TUESDAY), []);
});

test('an add cannot re-open an already-booked instant', async () => {
  const { orgA } = ctx.fixtures;
  // No recurring window: the add is the only source of candidates.
  await seedBooking(orgA.teacher1, orgA.student1a, '2026-08-11 18:00:00'); // 14:00 EDT
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'add', start_time: '14:00', end_time: '15:00' }
  });

  const slots = await openSlots(orgA.teacher1, TUESDAY);
  // This fails if adds are folded in AFTER the booking subtraction.
  assert.ok(!slots.includes('2026-08-11T18:00:00.000Z'), 'booked instant was re-offered');
  assert.ok(slots.includes('2026-08-11T18:30:00.000Z'));
});

test('POST /bookings refuses a blocked instant and creates no row', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '11:00');
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: TUESDAY, type: 'block' }
  });

  const res = await post('/bookings', {
    token: tokenFor(orgA.student1a),
    body: { scheduled_at: '2026-08-11T13:00:00.000Z' }
  });

  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal((await bookingRows()).length, 0);
});

// ---------------------------------------------------------------------------
// E. DST edge cases -- fixed dates, never relative to now.
// US transitions: spring forward Sun 2026-03-08, fall back Sun 2026-11-01.
// ---------------------------------------------------------------------------

test('a whole-day block covers the 25-hour fall-back day', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, 0, '00:00', '23:30'); // Sunday
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: '2026-11-01', type: 'block' }
  });

  // A naive dayStart + 24h boundary leaves the final hour unblocked.
  assert.deepEqual(await openSlots(orgA.teacher1, '2026-11-01'), []);
});

test('a whole-day block on the 23-hour spring-forward day does not leak into Monday', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, 0, '00:00', '23:30'); // Sunday
  await seedWindow(orgA.teacher1, 1, '09:00', '10:00'); // Monday
  await post('/availability-exceptions', {
    token: tokenFor(orgA.teacher1),
    body: { date: '2026-03-08', type: 'block' }
  });

  assert.deepEqual(await openSlots(orgA.teacher1, '2026-03-08'), []);
  // Monday 2026-03-09 must be untouched -- an over-wide boundary would eat it.
  assert.equal((await openSlots(orgA.teacher1, '2026-03-09')).length, 2);
});

test('slot offsets shift correctly across a DST boundary inside one range', async () => {
  const { orgA } = ctx.fixtures;
  // A 09:00 window every day of the week.
  for (let dow = 0; dow <= 6; dow += 1) {
    await seedWindow(orgA.teacher1, dow, '09:00', '09:30');
  }

  const res = await get('/bookings/open-slots-range?from=2026-10-30&to=2026-11-03', {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byDate = res.body.slots_by_date;

  // Before the Nov 1 transition: EDT, UTC-4.
  assert.deepEqual(byDate['2026-10-30'], ['2026-10-30T13:00:00.000Z']);
  assert.deepEqual(byDate['2026-10-31'], ['2026-10-31T13:00:00.000Z']);
  // After: EST, UTC-5. Fails loudly if the day loop steps a fixed 86.4M ms.
  assert.deepEqual(byDate['2026-11-02'], ['2026-11-02T14:00:00.000Z']);
  assert.deepEqual(byDate['2026-11-03'], ['2026-11-03T14:00:00.000Z']);
});

// ---------------------------------------------------------------------------
// F. Range endpoint
// ---------------------------------------------------------------------------

test('the range includes every date, empty ones included', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '10:00');

  const res = await get('/bookings/open-slots-range?from=2026-08-10&to=2026-08-16', {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const dates = Object.keys(res.body.slots_by_date).sort();
  assert.deepEqual(dates, [
    '2026-08-10',
    '2026-08-11',
    '2026-08-12',
    '2026-08-13',
    '2026-08-14',
    '2026-08-15',
    '2026-08-16'
  ]);
  // Only the Tuesday has slots; every other day is present but empty.
  assert.equal(res.body.slots_by_date['2026-08-11'].length, 2);
  assert.deepEqual(res.body.slots_by_date['2026-08-10'], []);
  assert.deepEqual(res.body.slots_by_date['2026-08-16'], []);
});

test('the range cap and reversed ranges are rejected', async () => {
  const { orgA } = ctx.fixtures;
  const token = tokenFor(orgA.teacher1);

  // Exactly MAX_RANGE_DAYS is allowed.
  const atCap = await get(`/bookings/open-slots-range?from=2026-08-01&to=2026-08-${MAX_RANGE_DAYS}`, {
    token
  });
  assert.equal(atCap.status, 200, JSON.stringify(atCap.body));

  // One day over is not.
  const overCap = await get('/bookings/open-slots-range?from=2026-08-01&to=2026-09-01', { token });
  assert.equal(overCap.status, 400, JSON.stringify(overCap.body));

  // Reversed must 400, not return an empty object.
  const reversed = await get('/bookings/open-slots-range?from=2026-08-10&to=2026-08-01', { token });
  assert.equal(reversed.status, 400, JSON.stringify(reversed.body));
});

test('the range endpoint issues a constant number of queries regardless of span', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '10:00');

  const pool = require('../../src/db/pool');
  const original = pool.query;
  let count = 0;
  pool.query = function countingQuery(...args) {
    count += 1;
    return original.apply(this, args);
  };

  try {
    count = 0;
    await get('/bookings/open-slots-range?from=2026-08-11&to=2026-08-11', {
      token: tokenFor(orgA.teacher1)
    });
    const oneDay = count;

    count = 0;
    await get('/bookings/open-slots-range?from=2026-08-01&to=2026-08-31', {
      token: tokenFor(orgA.teacher1)
    });
    const thirtyOneDays = count;

    // Without this assertion, a future per-day `await` loop passes every other
    // test in this file while restoring exactly the N+1 the endpoint exists to
    // remove.
    assert.equal(
      thirtyOneDays,
      oneDay,
      `query count grew with span: ${oneDay} -> ${thirtyOneDays}`
    );
    assert.equal(oneDay, 3, `expected 3 queries, got ${oneDay}`);
  } finally {
    pool.query = original;
  }
});

test('a booking before the range start still blocks a slot inside it', async () => {
  const { orgA } = ctx.fixtures;
  await seedWindow(orgA.teacher1, 1, '00:00', '01:00'); // Monday 00:00 EDT
  // A 90-minute booking starting 23:30 Eastern on Sunday 2026-08-09 runs into
  // Monday. In August that is 03:30Z on the 10th.
  await seedBooking(orgA.teacher1, orgA.student1a, '2026-08-10 03:30:00', 90);

  const res = await get('/bookings/open-slots-range?from=2026-08-10&to=2026-08-10', {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // Monday 00:00 EDT == 04:00Z, which falls inside the booking's 03:30-05:00Z
  // span, so it must not be offered.
  assert.ok(
    !res.body.slots_by_date['2026-08-10'].includes('2026-08-10T04:00:00.000Z'),
    'a booking starting before the range start was not subtracted'
  );
});

test('the range endpoint scopes by role', async () => {
  const { orgA, orgB } = ctx.fixtures;
  await seedWindow(orgA.teacher1, TUESDAY_DOW, '09:00', '10:00');
  const range = `from=${TUESDAY}&to=${TUESDAY}`;

  // A student gets their own teacher's calendar.
  const student = await get(`/bookings/open-slots-range?${range}`, {
    token: tokenFor(orgA.student1a)
  });
  assert.equal(student.status, 200, JSON.stringify(student.body));
  assert.equal(student.body.slots_by_date[TUESDAY].length, 2);

  // A manager has no calendar and is refused.
  const manager = await get(`/bookings/open-slots-range?${range}`, {
    token: tokenFor(orgA.manager)
  });
  assert.equal(manager.status, 403, JSON.stringify(manager.body));

  // An owner must name a teacher, and only one in their own org.
  const ownerBare = await get(`/bookings/open-slots-range?${range}`, {
    token: tokenFor(orgA.owner)
  });
  assert.equal(ownerBare.status, 400, JSON.stringify(ownerBare.body));

  const ownerCrossOrg = await get(
    `/bookings/open-slots-range?${range}&admin_id=${orgB.teacher.id}`,
    { token: tokenFor(orgA.owner) }
  );
  assert.equal(ownerCrossOrg.status, 400, JSON.stringify(ownerCrossOrg.body));
});
