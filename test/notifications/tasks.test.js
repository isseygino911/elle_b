'use strict';

// Phase 2 -- task_assigned and task_completed.
//
// Neither event exists today: tasks.route.js never imports the notification
// helpers at all. This is the event the user believed already worked ("I see
// notifications when a task is created"), so the negatives below matter as much
// as the positives -- getting this noisy would be worse than leaving it absent.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { post, patch } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

// Reads notifications addressed to one user. Ordered so a test asserting on
// rows[0] is deterministic rather than depending on insertion order surviving
// the optimizer.
async function notificationsFor(userId) {
  const [rows] = await ctx.pool.query(
    'SELECT type, ref_id, actor_id, title, body FROM notifications WHERE user_id = ? ORDER BY id ASC',
    [userId]
  );
  return rows;
}

test('assigning a task to a student notifies that student', async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/tasks', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Practice the D scale', assigned_to: orgA.student1a.id }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const rows = await notificationsFor(orgA.student1a.id);
  assert.equal(rows.length, 1, 'the assigned student must be told');
  assert.equal(rows[0].type, 'task_assigned');
  assert.equal(Number(rows[0].ref_id), Number(created.body.task.id));
  assert.equal(rows[0].actor_id, orgA.teacher1.id);
  // The title is the one piece of content worth carrying: a task list entry is
  // not private correspondence, and without it the notification cannot say
  // which task it means.
  assert.match(rows[0].title, /Practice the D scale/);
});

test('an unassigned task notifies nobody', async () => {
  const { orgA } = ctx.fixtures;

  // assigned_to omitted entirely -- a teacher's own to-do, not an assignment.
  const created = await post('/tasks', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Reorder the sheet music cabinet' }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, [], 'a task with no assignee has no recipient');
});

test('assigning a task to yourself notifies nobody', async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/tasks', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Prepare recital programme', assigned_to: orgA.teacher1.id }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const rows = await notificationsFor(orgA.teacher1.id);
  assert.deepEqual(rows, [], 'nobody should be notified of their own action');
});

test('a student completing their task notifies the teacher who set it', async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/tasks', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Record the Bach minuet', assigned_to: orgA.student1a.id }
  });
  const taskId = created.body.task.id;

  // Clear the task_assigned row so this test asserts only on what the PATCH
  // produced.
  await ctx.pool.query('DELETE FROM notifications');

  const done = await patch(`/tasks/${taskId}`, {
    token: tokenFor(orgA.student1a),
    body: { status: 'done' }
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const rows = await notificationsFor(orgA.teacher1.id);
  assert.equal(rows.length, 1, 'the task creator must learn it was finished');
  assert.equal(rows[0].type, 'task_completed');
  assert.equal(Number(rows[0].ref_id), Number(taskId));
  assert.equal(rows[0].actor_id, orgA.student1a.id);
});

test('a teacher marking their own assigned task done does not notify themselves', async () => {
  const { orgA } = ctx.fixtures;

  // The creator and the actor are the same person. The UPDATE's
  // `(created_by = ? OR assigned_to = ?)` predicate matches either way, which
  // is exactly why the handler has to read the row rather than infer intent
  // from affectedRows.
  const created = await post('/tasks', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Chase up the tuning appointment', assigned_to: orgA.student1a.id }
  });
  await ctx.pool.query('DELETE FROM notifications');

  const done = await patch(`/tasks/${created.body.task.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { status: 'done' }
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, [], 'a teacher tidying their own list is not a completion event');
});

test('reopening a task does not notify', async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/tasks', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Practice vibrato', assigned_to: orgA.student1a.id }
  });
  const taskId = created.body.task.id;

  await patch(`/tasks/${taskId}`, {
    token: tokenFor(orgA.student1a),
    body: { status: 'done' }
  });
  await ctx.pool.query('DELETE FROM notifications');

  // done -> pending. Only the transition INTO done is an event; without this
  // guard a student toggling a checkbox would notify their teacher each time.
  const reopened = await patch(`/tasks/${taskId}`, {
    token: tokenFor(orgA.student1a),
    body: { status: 'pending' }
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, [], 'only the transition into done is an event');
});

test('re-completing an already-done task does not notify twice', async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/tasks', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Scales at 60bpm', assigned_to: orgA.student1a.id }
  });
  const taskId = created.body.task.id;

  await patch(`/tasks/${taskId}`, {
    token: tokenFor(orgA.student1a),
    body: { status: 'done' }
  });
  await ctx.pool.query('DELETE FROM notifications');

  // Already done. A client retrying the same PATCH -- a double-tap, an offline
  // queue flushing -- must not produce a second notification.
  await patch(`/tasks/${taskId}`, {
    token: tokenFor(orgA.student1a),
    body: { status: 'done' }
  });

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, [], 'done -> done is not a transition');
});

test('a task cannot be assigned across organizations', async () => {
  const { orgA, orgB } = ctx.fixtures;

  // Pre-existing behaviour, asserted here because task_assigned now writes a
  // notification off the back of it: if this fence ever broke, the notification
  // would be the mechanism that delivered the leak.
  const created = await post('/tasks', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Cross-tenant task', assigned_to: orgB.student.id }
  });

  assert.equal(created.status, 400, JSON.stringify(created.body));

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, [], 'a rejected assignment writes nothing');
});
