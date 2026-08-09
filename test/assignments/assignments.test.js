'use strict';

// Phase 3 -- assignments, publishing, and the due-date dashboard section.
//
// The boundaries asserted here, in the plan's own terms:
//
//   1. A DRAFT notifies nobody, and is invisible to a student entirely. A
//      teacher's unfinished thinking is not an event.
//   2. PUBLISHING notifies exactly the enrolled students -- not the teacher's
//      other students, not another course's, nobody in another org.
//   3. RE-PUBLISHING does not re-notify. The FOR UPDATE read-before-update is
//      what makes this true, and a typo fix after publishing is the ordinary
//      case that would otherwise spam every student.
//   4. A manager is refused on every endpoint. They outrank a teacher who is
//      allowed, so any rank-based gate passes them.
//   5. A teacher cannot reach another teacher's assignments, and cross-org is
//      invisible in both directions.
//   6. The due date reaches the dashboard payload, on the existing response
//      rather than behind a second fetch.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { get, post, patch } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

async function notificationRows(type = 'assignment_published') {
  const [rows] = await ctx.pool.query(
    'SELECT * FROM notifications WHERE type = ? ORDER BY id ASC',
    [type]
  );
  return rows;
}

async function assignmentRows() {
  const [rows] = await ctx.pool.query('SELECT * FROM assignments ORDER BY id ASC');
  return rows;
}

// A date `days` from today in YYYY-MM-DD, built from local y/m/d rather than
// toISOString() -- the same reason formatDateOnly avoids UTC conversion. A
// toISOString() date here would land on the wrong day for anyone west of
// Greenwich and make the dashboard window test flap by timezone.
function dateInDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

// Course owned by `teacher`, with `students` enrolled. Goes through the API so
// the fixture exercises the same path the tests are about.
async function courseWithStudents(teacher, students = [], title = 'Grade 3 Repertoire') {
  const created = await post('/courses', { token: tokenFor(teacher), body: { title } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const courseId = created.body.course.id;

  for (const student of students) {
    const enrolled = await post(`/courses/${courseId}/enrollments`, {
      token: tokenFor(teacher),
      body: { student_id: student.id }
    });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  }

  return courseId;
}

async function createAssignment(teacher, courseId, body = {}) {
  const created = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(teacher),
    body: { title: 'Scales, Friday', ...body }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.assignment;
}

async function publish(teacher, courseId, assignmentId) {
  return patch(`/courses/${courseId}/assignments/${assignmentId}`, {
    token: tokenFor(teacher),
    body: { status: 'published' }
  });
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

test('an assignment is created as a draft and notifies nobody', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a, orgA.student1b]);

  const assignment = await createAssignment(orgA.teacher1, courseId, {
    body: 'Two octaves, hands separately.',
    due_date: dateInDays(3)
  });

  assert.equal(assignment.status, 'draft');
  assert.equal(assignment.title, 'Scales, Friday');
  assert.equal(assignment.body, 'Two octaves, hands separately.');
  assert.equal(assignment.due_date, dateInDays(3));

  // The whole point of the draft state. Two students are enrolled and ready to
  // be told; creating must not tell them.
  assert.deepEqual(await notificationRows(), []);
});

test('assignment defaults mirror the column defaults', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1);

  const assignment = await createAssignment(orgA.teacher1, courseId);

  assert.equal(assignment.accepts_text, true);
  assert.equal(assignment.accepts_files, true);
  // Recording defaults OFF -- opting in is a deliberate act by the teacher.
  assert.equal(assignment.accepts_recording, false);
  assert.equal(assignment.max_recording_sec, 300);
  assert.equal(assignment.allowed_attempts, null);

  // Booleans, not the 0/1 mysql2 hands back for TINYINT(1). A number here would
  // fail the schema on a GET-toggle-PATCH round trip.
  assert.equal(typeof assignment.accepts_text, 'boolean');
  assert.equal(typeof assignment.accepts_recording, 'boolean');
});

test('an assignment must accept at least one kind of submission', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1);

  const created = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(orgA.teacher1),
    body: {
      title: 'Impossible homework',
      accepts_text: false,
      accepts_files: false,
      accepts_recording: false
    }
  });

  assert.equal(created.status, 400, JSON.stringify(created.body));
  assert.deepEqual(await assignmentRows(), []);
});

test('a patch that would leave an assignment accepting nothing is refused', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1);

  // Files off at create, so turning text off later is what empties it. The
  // route can only catch this by merging the patch with the stored row -- a
  // schema-only check sees one flag and cannot know the other two.
  const assignment = await createAssignment(orgA.teacher1, courseId, {
    accepts_text: true,
    accepts_files: false,
    accepts_recording: false
  });

  const patched = await patch(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { accepts_text: false }
  });

  assert.equal(patched.status, 400, JSON.stringify(patched.body));

  // And the row is untouched -- the rollback, not just the status code.
  const rows = await assignmentRows();
  assert.equal(Boolean(rows[0].accepts_text), true);
});

test('reference_url rejects a non-http scheme', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1);

  // The link is rendered as an anchor on every enrolled student's page, so a
  // javascript: URL here would be a delivery vector, not merely bad data.
  const created = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Bad link', reference_url: 'javascript:alert(1)' }
  });

  assert.equal(created.status, 400, JSON.stringify(created.body));

  const ok = await createAssignment(orgA.teacher1, courseId, {
    reference_url: 'https://imslp.org/wiki/Special:ReverseLookup/12345'
  });
  assert.equal(ok.reference_url, 'https://imslp.org/wiki/Special:ReverseLookup/12345');
});

// ---------------------------------------------------------------------------
// Publishing and the fan-out
// ---------------------------------------------------------------------------

test('publishing notifies exactly the enrolled students', async () => {
  const { orgA } = ctx.fixtures;

  // student1b is on teacher1's roster but NOT enrolled. student2a belongs to
  // another teacher. Neither may be notified -- the first is the sharp case,
  // since any implementation that fanned out by admin_id instead of enrollment
  // would wrongly include them.
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId, {
    due_date: dateInDays(5)
  });

  const published = await publish(orgA.teacher1, courseId, assignment.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.assignment.status, 'published');

  const notifications = await notificationRows();
  assert.equal(notifications.length, 1);
  assert.equal(Number(notifications[0].user_id), orgA.student1a.id);
  assert.equal(Number(notifications[0].actor_id), orgA.teacher1.id);
  assert.equal(Number(notifications[0].ref_id), assignment.id);
  assert.equal(notifications[0].title, 'New homework: Scales, Friday');
  assert.equal(notifications[0].body, `Due ${dateInDays(5)}`);

  const notified = notifications.map((row) => Number(row.user_id));
  assert.equal(notified.includes(orgA.student1b.id), false);
  assert.equal(notified.includes(orgA.student2a.id), false);
});

test('re-publishing does not notify a second time', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a, orgA.student1b]);
  const assignment = await createAssignment(orgA.teacher1, courseId);

  await publish(orgA.teacher1, courseId, assignment.id);
  assert.equal((await notificationRows()).length, 2);

  // Publishing again, and the ordinary case that makes this matter: fixing a
  // typo in an already-published assignment.
  await publish(orgA.teacher1, courseId, assignment.id);
  const renamed = await patch(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Scales, Friday (two octaves)', status: 'published' }
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));

  assert.equal((await notificationRows()).length, 2);
  assert.equal(renamed.body.assignment.title, 'Scales, Friday (two octaves)');
});

test('publishing an assignment with no due date sends a notification without one', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);

  await publish(orgA.teacher1, courseId, assignment.id);

  const notifications = await notificationRows();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].body, null);
});

test('publishing into a course with no enrolled students notifies nobody', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1);
  const assignment = await createAssignment(orgA.teacher1, courseId);

  // Legitimate -- a teacher may set up homework before enrolling anyone -- so
  // this is a 200, not an error. The route logs a warning so the no-op is
  // distinguishable from delivery in the logs.
  const published = await publish(orgA.teacher1, courseId, assignment.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.deepEqual(await notificationRows(), []);
});

test('retracting an assignment removes it from every student', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a, orgA.student1b]);
  const assignment = await createAssignment(orgA.teacher1, courseId);
  await publish(orgA.teacher1, courseId, assignment.id);
  assert.equal((await notificationRows()).length, 2);

  // Published to the wrong course, or before the instruction was finished --
  // an ordinary correction, not an error.
  const retracted = await patch(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { status: 'draft' }
  });

  assert.equal(retracted.status, 200, JSON.stringify(retracted.body));
  assert.equal(retracted.body.assignment.status, 'draft');

  // Gone, not merely hidden. A "New homework" line pointing at an assignment
  // the student can no longer open is worse than no line at all.
  assert.deepEqual(await notificationRows(), []);

  const listed = await get(`/courses/${courseId}/assignments`, {
    token: tokenFor(orgA.student1a)
  });
  assert.deepEqual(listed.body.assignments, []);

  const direct = await get(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.student1a)
  });
  assert.equal(direct.status, 404, JSON.stringify(direct.body));
});

test('retracting deletes only its own notifications', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);

  const keep = await createAssignment(orgA.teacher1, courseId, { title: 'Still live' });
  const drop = await createAssignment(orgA.teacher1, courseId, { title: 'Retracted' });
  await publish(orgA.teacher1, courseId, keep.id);
  await publish(orgA.teacher1, courseId, drop.id);
  assert.equal((await notificationRows()).length, 2);

  await patch(`/courses/${courseId}/assignments/${drop.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { status: 'draft' }
  });

  const remaining = await notificationRows();
  assert.equal(remaining.length, 1);
  assert.equal(Number(remaining[0].ref_id), keep.id);
  assert.equal(remaining[0].title, 'New homework: Still live');
});

test('re-publishing after a retraction notifies again', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);

  await publish(orgA.teacher1, courseId, assignment.id);
  await patch(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { status: 'draft' }
  });

  // The retraction deleted the first notification, so this is a genuine new
  // announcement rather than a duplicate -- the student was told it was
  // withdrawn (by its disappearance) and must now be told it is back.
  const republished = await publish(orgA.teacher1, courseId, assignment.id);
  assert.equal(republished.status, 200, JSON.stringify(republished.body));

  const notifications = await notificationRows();
  assert.equal(notifications.length, 1);
  assert.equal(Number(notifications[0].user_id), orgA.student1a.id);
});

test('an assignment with submitted work cannot be retracted', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);
  await publish(orgA.teacher1, courseId, assignment.id);

  // Inserted directly: the submissions route is Phase 4 and does not exist
  // yet, but the table does, and this guard is meaningless without a row to
  // guard. Phase 4 will exercise the same path through the API.
  await ctx.pool.query(
    'INSERT INTO submissions (org_id, assignment_id, student_id, attempt, body) VALUES (?, ?, ?, ?, ?)',
    [orgA.id, assignment.id, orgA.student1a.id, 1, 'Practised twice daily.']
  );

  const retracted = await patch(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { status: 'draft' }
  });

  // 409, not 400: the request is well-formed and would be fine at another
  // time. It conflicts with state that now exists.
  assert.equal(retracted.status, 409, JSON.stringify(retracted.body));

  // Still published, and the student's notification is intact -- the whole
  // transaction rolled back, not just the status write.
  const rows = await assignmentRows();
  assert.equal(rows[0].status, 'published');
  assert.equal((await notificationRows()).length, 1);
});

test('an assignment with submitted work can still be edited in place', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);
  await publish(orgA.teacher1, courseId, assignment.id);

  await ctx.pool.query(
    'INSERT INTO submissions (org_id, assignment_id, student_id, attempt, body) VALUES (?, ?, ?, ?, ?)',
    [orgA.id, assignment.id, orgA.student1a.id, 1, 'Practised twice daily.']
  );

  // The refusal above is specifically about RETRACTING. Fixing a typo or
  // extending the deadline on homework people are working on must still work,
  // or the guard would have made the assignment read-only.
  const edited = await patch(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Scales, Friday (two octaves)', due_date: dateInDays(9) }
  });

  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.assignment.title, 'Scales, Friday (two octaves)');
  assert.equal(edited.body.assignment.due_date, dateInDays(9));
});

// ---------------------------------------------------------------------------
// What a student sees
// ---------------------------------------------------------------------------

test('a student sees published assignments only, and never a draft', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);

  const draft = await createAssignment(orgA.teacher1, courseId, { title: 'Not ready yet' });
  const live = await createAssignment(orgA.teacher1, courseId, { title: 'Scales, Friday' });
  await publish(orgA.teacher1, courseId, live.id);

  const listed = await get(`/courses/${courseId}/assignments`, {
    token: tokenFor(orgA.student1a)
  });

  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.assignments.length, 1);
  assert.equal(listed.body.assignments[0].title, 'Scales, Friday');

  // Asserted against the raw JSON: a draft title must not appear anywhere in
  // the response, not merely be filtered by whatever renders it.
  assert.equal(JSON.stringify(listed.body).includes('Not ready yet'), false);

  // And asking for it directly is a 404, not a 403 -- a student should not
  // learn that unpublished homework exists.
  const direct = await get(`/courses/${courseId}/assignments/${draft.id}`, {
    token: tokenFor(orgA.student1a)
  });
  assert.equal(direct.status, 404, JSON.stringify(direct.body));
});

test('a student explicitly asking for drafts still gets published only', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  await createAssignment(orgA.teacher1, courseId, { title: 'Not ready yet' });

  const listed = await get(`/courses/${courseId}/assignments?status=draft`, {
    token: tokenFor(orgA.student1a)
  });

  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.assignments, []);
});

test('a student not enrolled in the course sees no assignments at all', async () => {
  const { orgA } = ctx.fixtures;

  // student1b is taught by teacher1 but is not enrolled in this course. The
  // course itself is already invisible to them, so the assignment list under it
  // must be too.
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);
  await publish(orgA.teacher1, courseId, assignment.id);

  const listed = await get(`/courses/${courseId}/assignments`, {
    token: tokenFor(orgA.student1b)
  });
  assert.equal(listed.status, 404, JSON.stringify(listed.body));

  const direct = await get(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.student1b)
  });
  assert.equal(direct.status, 404, JSON.stringify(direct.body));
});

test('a student cannot create, edit, or publish an assignment', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);
  await publish(orgA.teacher1, courseId, assignment.id);

  const created = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(orgA.student1a),
    body: { title: 'Homework I set myself' }
  });
  assert.equal(created.status, 403, JSON.stringify(created.body));

  const patched = await patch(`/courses/${courseId}/assignments/${assignment.id}`, {
    token: tokenFor(orgA.student1a),
    body: { title: 'Renamed by a student' }
  });
  assert.equal(patched.status, 403, JSON.stringify(patched.body));

  const rows = await assignmentRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Scales, Friday');
});

// ---------------------------------------------------------------------------
// The boundaries that must not regress
// ---------------------------------------------------------------------------

test('a manager is refused on every assignment endpoint', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);

  // A manager outranks a teacher, so any rank-based gate lets them through.
  // An assignment names a course whose roster is a list of students, which is
  // the manager's one hard exclusion.
  const token = tokenFor(orgA.manager);
  const attempts = [
    post(`/courses/${courseId}/assignments`, { token, body: { title: 'Manager homework' } }),
    get(`/courses/${courseId}/assignments`, { token }),
    get(`/courses/${courseId}/assignments/${assignment.id}`, { token }),
    patch(`/courses/${courseId}/assignments/${assignment.id}`, { token, body: { title: 'Edited' } })
  ];

  for (const attempt of await Promise.all(attempts)) {
    assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
  }

  const rows = await assignmentRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Scales, Friday');
});

test('a teacher cannot reach another teacher\'s assignments', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);

  const token = tokenFor(orgA.teacher2);

  // 404, not 403: teacher2 must not be able to tell teacher1's course apart
  // from one that does not exist.
  const listed = await get(`/courses/${courseId}/assignments`, { token });
  assert.equal(listed.status, 404, JSON.stringify(listed.body));

  const created = await post(`/courses/${courseId}/assignments`, {
    token,
    body: { title: 'Homework in a course that is not mine' }
  });
  assert.equal(created.status, 404, JSON.stringify(created.body));

  const patched = await patch(`/courses/${courseId}/assignments/${assignment.id}`, {
    token,
    body: { title: 'Edited by the wrong teacher' }
  });
  assert.equal(patched.status, 404, JSON.stringify(patched.body));

  const rows = await assignmentRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Scales, Friday');
});

test('an assignment is invisible across organizations', async () => {
  const { orgA, orgB } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);
  await publish(orgA.teacher1, courseId, assignment.id);

  // Org B's owner is the most privileged role in that tenant, which is what
  // makes them the right prober: if the tenancy fence holds for them it holds
  // for everyone below.
  for (const user of [orgB.owner, orgB.teacher, orgB.student]) {
    const listed = await get(`/courses/${courseId}/assignments`, { token: tokenFor(user) });
    assert.equal(listed.status, 404, JSON.stringify(listed.body));

    const direct = await get(`/courses/${courseId}/assignments/${assignment.id}`, {
      token: tokenFor(user)
    });
    assert.equal(direct.status, 404, JSON.stringify(direct.body));
  }
});

test('an assignment id from another course is not readable through a course the caller can see', async () => {
  const { orgA } = ctx.fixtures;

  const ownCourse = await courseWithStudents(orgA.teacher1, [orgA.student1a], 'My course');
  const otherCourse = await courseWithStudents(orgA.teacher2, [orgA.student2a], 'Their course');
  const foreign = await createAssignment(orgA.teacher2, otherCourse, { title: 'Their homework' });

  // The :courseId in the path is teacher1's own, so the course check passes.
  // Only the course_id predicate on the assignment query stops this -- without
  // it the path segment would be decorative.
  const direct = await get(`/courses/${ownCourse}/assignments/${foreign.id}`, {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(direct.status, 404, JSON.stringify(direct.body));

  const patched = await patch(`/courses/${ownCourse}/assignments/${foreign.id}`, {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Edited through the wrong course' }
  });
  assert.equal(patched.status, 404, JSON.stringify(patched.body));
});

test('an owner sees and edits assignments across their organization', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId);

  const listed = await get(`/courses/${courseId}/assignments`, { token: tokenFor(orgA.owner) });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.assignments.length, 1);

  // And an owner publishing on a teacher's behalf still fans out to that
  // teacher's enrolled students, with the owner recorded as the actor.
  const published = await publish(orgA.owner, courseId, assignment.id);
  assert.equal(published.status, 200, JSON.stringify(published.body));

  const notifications = await notificationRows();
  assert.equal(notifications.length, 1);
  assert.equal(Number(notifications[0].user_id), orgA.student1a.id);
  assert.equal(Number(notifications[0].actor_id), orgA.owner.id);
});

// ---------------------------------------------------------------------------
// The dashboard section
// ---------------------------------------------------------------------------

test('a due date reaches the student dashboard payload', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId, {
    due_date: dateInDays(2)
  });
  await publish(orgA.teacher1, courseId, assignment.id);

  const dashboard = await get('/dashboard', { token: tokenFor(orgA.student1a) });

  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
  assert.equal(dashboard.body.assignments_due.count, 1);
  assert.equal(dashboard.body.assignments_due.assignments[0].title, 'Scales, Friday');
  assert.equal(dashboard.body.assignments_due.assignments[0].due_date, dateInDays(2));
  // Carried so the dashboard can say which course without a second fetch.
  assert.equal(dashboard.body.assignments_due.assignments[0].course_title, 'Grade 3 Repertoire');
});

test('a draft and a past due date stay off the dashboard', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);

  // Draft with a due date inside the window.
  await createAssignment(orgA.teacher1, courseId, { title: 'Draft', due_date: dateInDays(2) });

  // Published but overdue.
  const past = await createAssignment(orgA.teacher1, courseId, {
    title: 'Last week',
    due_date: dateInDays(-7)
  });
  await publish(orgA.teacher1, courseId, past.id);

  // Published but beyond the horizon.
  const far = await createAssignment(orgA.teacher1, courseId, {
    title: 'Next term',
    due_date: dateInDays(90)
  });
  await publish(orgA.teacher1, courseId, far.id);

  const dashboard = await get('/dashboard', { token: tokenFor(orgA.student1a) });

  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
  assert.equal(dashboard.body.assignments_due.count, 0);
  assert.equal(JSON.stringify(dashboard.body.assignments_due).includes('Draft'), false);
});

test('a student dashboard carries only their own enrolled homework', async () => {
  const { orgA } = ctx.fixtures;

  const mine = await courseWithStudents(orgA.teacher1, [orgA.student1a], 'Mine');
  const theirs = await courseWithStudents(orgA.teacher1, [orgA.student1b], 'Theirs');

  const a = await createAssignment(orgA.teacher1, mine, { title: 'My homework', due_date: dateInDays(1) });
  const b = await createAssignment(orgA.teacher1, theirs, { title: 'Their homework', due_date: dateInDays(1) });
  await publish(orgA.teacher1, mine, a.id);
  await publish(orgA.teacher1, theirs, b.id);

  const dashboard = await get('/dashboard', { token: tokenFor(orgA.student1a) });

  assert.equal(dashboard.body.assignments_due.count, 1);
  // Both courses belong to the same teacher, so an implementation scoping the
  // student by admin_id rather than by enrollment would return both. Asserted
  // on the raw JSON.
  assert.equal(JSON.stringify(dashboard.body).includes('Their homework'), false);
});

test('a teacher dashboard carries their own courses homework, an owner the whole org', async () => {
  const { orgA } = ctx.fixtures;

  const c1 = await courseWithStudents(orgA.teacher1, [orgA.student1a], 'Teacher one course');
  const c2 = await courseWithStudents(orgA.teacher2, [orgA.student2a], 'Teacher two course');

  const a1 = await createAssignment(orgA.teacher1, c1, { title: 'One homework', due_date: dateInDays(1) });
  const a2 = await createAssignment(orgA.teacher2, c2, { title: 'Two homework', due_date: dateInDays(1) });
  await publish(orgA.teacher1, c1, a1.id);
  await publish(orgA.teacher2, c2, a2.id);

  const teacherView = await get('/dashboard', { token: tokenFor(orgA.teacher1) });
  assert.equal(teacherView.body.assignments_due.count, 1);
  assert.equal(JSON.stringify(teacherView.body.assignments_due).includes('Two homework'), false);

  const ownerView = await get('/dashboard', { token: tokenFor(orgA.owner) });
  assert.equal(ownerView.body.assignments_due.count, 2);
});

test('the manager dashboard carries no homework section at all', async () => {
  const { orgA } = ctx.fixtures;
  const courseId = await courseWithStudents(orgA.teacher1, [orgA.student1a]);
  const assignment = await createAssignment(orgA.teacher1, courseId, {
    title: 'Scales, Friday',
    due_date: dateInDays(2)
  });
  await publish(orgA.teacher1, courseId, assignment.id);

  const dashboard = await get('/dashboard', { token: tokenFor(orgA.manager) });

  assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
  // Not an empty section -- absent. The manager dashboard is aggregates only,
  // and there is no count of homework that tells them something actionable.
  assert.equal(dashboard.body.assignments_due, undefined);
  assert.equal(JSON.stringify(dashboard.body).includes('Scales, Friday'), false);
});
