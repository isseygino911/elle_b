'use strict';

// BUG D -- booking created and booking cancelled were indistinguishable.
// BUG E -- the cancel call site passed req.params.id, a string, where every
//          other site passes a numeric insertId.
// BUG B -- when an owner acts, the student's own teacher is never notified.
// BUG C -- an unassigned student's action drops its notification silently in
//          messages/comments, but is rejected with a 400 in bookings.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { post, patch, get } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

// Bookings need an availability window before any slot is open.
//
// The table is (admin_id, day_of_week, start_time, end_time) -- no org_id
// column; tenancy is reached through admin_id. Seeds every weekday so the
// fixed date below is covered whichever day it falls on.
async function openAvailability(pool, adminId) {
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    await pool.query(
      'INSERT INTO availability (admin_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)',
      [adminId, dayOfWeek, '09:00:00', '17:00:00']
    );
  }
}

// A fixed future Wednesday at 14:00 Eastern, expressed as the UTC instant the
// API expects. Chosen rather than "now + n days" so the test does not drift
// across a DST boundary and start failing in a specific week of the year.
const SLOT_UTC = '2027-03-10T18:00:00.000Z';

test('booking created and cancelled produce distinguishable notifications', async () => {
  const { orgA } = ctx.fixtures;
  await openAvailability(ctx.pool, orgA.teacher1.id);

  const created = await post('/bookings', {
    token: tokenFor(orgA.student1a),
    body: { scheduled_at: SLOT_UTC }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const bookingId = created.body.booking.id;

  const cancelled = await patch(`/bookings/${bookingId}`, {
    token: tokenFor(orgA.student1a),
    body: { status: 'cancelled' }
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  // Both notifications land on the teacher, since the student acted.
  const [rows] = await ctx.pool.query(
    'SELECT type, ref_id FROM notifications WHERE user_id = ? ORDER BY id ASC',
    [orgA.teacher1.id]
  );

  const types = rows.map((row) => row.type);
  assert.deepEqual(
    types,
    ['booking_created', 'booking_cancelled'],
    'create and cancel must be tellable apart from the row alone'
  );

  // BUG E: both ref_ids point at the same booking and both are numeric.
  assert.equal(Number(rows[0].ref_id), Number(bookingId));
  assert.equal(Number(rows[1].ref_id), Number(bookingId));
});

test('owner acting on a student also notifies that student\'s teacher (BUG B)', async () => {
  const { orgA } = ctx.fixtures;

  const res = await post(`/messages/${orgA.student1a.id}`, {
    token: tokenFor(orgA.owner),
    body: { body: 'A note from the studio owner' }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const [studentRows] = await ctx.pool.query(
    'SELECT type FROM notifications WHERE user_id = ?',
    [orgA.student1a.id]
  );
  assert.equal(studentRows.length, 1, 'the student should be notified');

  const [teacherRows] = await ctx.pool.query(
    'SELECT type FROM notifications WHERE user_id = ?',
    [orgA.teacher1.id]
  );
  assert.equal(
    teacherRows.length,
    1,
    'the student\'s teacher owns this thread and must be notified too'
  );
});

test('a teacher acting on their own student does not notify themselves', async () => {
  const { orgA } = ctx.fixtures;

  await post(`/messages/${orgA.student1a.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { body: 'See you Tuesday' }
  });

  const [selfRows] = await ctx.pool.query(
    'SELECT id FROM notifications WHERE user_id = ?',
    [orgA.teacher1.id]
  );
  assert.deepEqual(selfRows, [], 'the actor must never be notified of their own action');

  const [studentRows] = await ctx.pool.query(
    'SELECT id FROM notifications WHERE user_id = ?',
    [orgA.student1a.id]
  );
  assert.equal(studentRows.length, 1);
});

test('an unassigned student can still send a message; nobody is notified (BUG C)', async () => {
  const { orgA } = ctx.fixtures;

  // orphanStudent has admin_id NULL, so there is no thread to write into:
  // messages.admin_id is NOT NULL (migration 0022). Before this fix the INSERT
  // reached the driver and the endpoint returned 500 -- a crash, not a
  // degradation. It is now rejected at the thread loader with a 409, matching
  // where bookings.route.js already rejects the same precondition.
  const res = await post(`/messages/${orgA.orphanStudent.id}`, {
    token: tokenFor(orgA.orphanStudent),
    body: { body: 'Is anyone there?' }
  });

  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.message, /not assigned to a teacher/);

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, [], 'a rejected action must leave no notification behind');
});

test('notification rows carry human-readable content (migration 0026)', async () => {
  const { orgA } = ctx.fixtures;

  await post(`/messages/${orgA.student1a.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { body: 'Practice the D scale' }
  });

  const res = await get('/notifications', { token: tokenFor(orgA.student1a) });
  const notification = res.body.notifications[0];

  assert.ok(notification.title, 'a notification must carry a title, not just an enum');
  assert.equal(notification.actor_id, orgA.teacher1.id);
  // actor_name is joined at read time rather than stored, so a rename is
  // reflected retroactively.
  assert.equal(notification.actor_name, orgA.teacher1.name);
});
