'use strict';

// GET /students/:id/detail -- everything about one student on one page.
//
// This endpoint returns bookings, courses, homework and videos for a NAMED
// student in a single payload, which makes it the widest per-student read in
// the app. The boundaries asserted here are exactly the ones that width puts
// at risk:
//
//   1. A manager is refused. They outrank a teacher who is allowed, so any
//      rank-based gate passes them -- the canonical wrong-check test, and the
//      reason the route uses requireCapability rather than requireMinRank.
//   2. A teacher cannot read another teacher's student, and gets 404 rather
//      than 403 so ids cannot be probed for existence.
//   3. Cross-org is invisible in both directions.
//   4. Draft assignments never appear. A draft has been fanned out to nobody,
//      so it is not yet this student's homework.
//   5. Each section contains only THIS student's rows -- the failure that
//      would matter most here is a section that forgets its student_id filter
//      and returns a sibling's work, which a count-only assertion would miss.
//   6. GET /students/admins still resolves -- proof the ':id'-prefixed route
//      registered alongside it did not shadow the literal path.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { get, post, patch } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

// Creates a course owned by `teacher`, enrolls `student`, and adds one
// assignment. Goes through the API so the fixture exercises the same paths the
// endpoint reads back -- rows inserted behind the routes' backs could satisfy
// an assertion the routes themselves would fail.
//
// `status` decides whether the assignment is published; the draft case is a
// test subject in its own right, not an edge case.
async function courseWithAssignment(
  teacher,
  student,
  { title = 'Grade 3 Repertoire', assignmentTitle = 'Scales, Friday', status = 'published', dueDate } = {}
) {
  const created = await post('/courses', { token: tokenFor(teacher), body: { title } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const courseId = created.body.course.id;

  const enrolled = await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(teacher),
    body: { student_id: student.id }
  });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));

  const body = { title: assignmentTitle };
  if (dueDate) body.due_date = dueDate;

  const assignment = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(teacher),
    body
  });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
  const assignmentId = assignment.body.assignment.id;

  if (status === 'published') {
    const published = await patch(`/courses/${courseId}/assignments/${assignmentId}`, {
      token: tokenFor(teacher),
      body: { status: 'published' }
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));
  }

  return { courseId, assignmentId };
}

// Bookings and videos are inserted directly. Booking creation goes through
// availability and slot rules that are not what these tests are about, and a
// video upload needs S3 -- the tables are what this endpoint reads.
async function insertBooking(teacher, student, scheduledAt, status = 'booked') {
  const [result] = await ctx.pool.query(
    `INSERT INTO bookings (org_id, admin_id, student_id, scheduled_at, duration_min, status, jitsi_room_id)
     VALUES (?, ?, ?, ?, 30, ?, ?)`,
    [teacher.orgId, teacher.id, student.id, scheduledAt, status, `room-${student.id}-${scheduledAt}`]
  );
  return result.insertId;
}

async function insertVideo(teacher, student, title, status = 'pending_review') {
  const [result] = await ctx.pool.query(
    `INSERT INTO videos (org_id, admin_id, student_id, type, title, s3_key, duration_sec, status, uploaded_by)
     VALUES (?, ?, ?, 'practice', ?, ?, 90, ?, ?)`,
    [teacher.orgId, teacher.id, student.id, title, `s3/${title}-${student.id}`, status, student.id]
  );
  return result.insertId;
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('an owner reads any student in their organization', async () => {
  const { orgA } = ctx.fixtures;

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.owner)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(Number(res.body.student.id), orgA.student1a.id);
  assert.equal(res.body.student.name, 'Student One A');
  assert.equal(res.body.student.email, 'student1a@test.local');
  // Every section is present even when empty, so the client never has to
  // distinguish "no rows" from "section missing".
  assert.deepEqual(res.body.bookings, { count: 0, bookings: [] });
  assert.deepEqual(res.body.courses, { count: 0, courses: [] });
  assert.deepEqual(res.body.homework, { count: 0, assignments: [] });
  assert.deepEqual(res.body.videos, { count: 0, videos: [] });
});

test('a teacher reads a student on their own roster', async () => {
  const { orgA } = ctx.fixtures;

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(Number(res.body.student.id), orgA.student1a.id);
});

test("a teacher cannot read another teacher's student, and gets 404 not 403", async () => {
  const { orgA } = ctx.fixtures;

  // student2a belongs to teacher2. 404 rather than 403 is the point: a
  // distinguishable "exists but not yours" would let a teacher enumerate the
  // roster of every peer in the organization.
  const res = await get(`/students/${orgA.student2a.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.student, undefined);
});

test('a manager is refused, despite outranking a teacher who is allowed', async () => {
  const { orgA } = ctx.fixtures;

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.manager)
  });

  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.student, undefined);
});

test('a student cannot read this endpoint, not even for themselves', async () => {
  const { orgA } = ctx.fixtures;

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.student1a)
  });

  assert.equal(res.status, 403, JSON.stringify(res.body));
});

test('an owner cannot reach a student in another organization', async () => {
  const { orgA, orgB } = ctx.fixtures;

  const res = await get(`/students/${orgB.student.id}/detail`, {
    token: tokenFor(orgA.owner)
  });

  assert.equal(res.status, 404, JSON.stringify(res.body));
});

test('an unknown student id is 404, and a non-numeric one is rejected', async () => {
  const { orgA } = ctx.fixtures;

  const missing = await get('/students/999999/detail', { token: tokenFor(orgA.owner) });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));

  const malformed = await get('/students/not-a-number/detail', { token: tokenFor(orgA.owner) });
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
});

test('a teacher cannot pass a peer id to reach a student who is not theirs', async () => {
  const { orgA } = ctx.fixtures;

  // orphanStudent is on nobody's roster. A teacher must not reach them.
  const res = await get(`/students/${orgA.orphanStudent.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 404, JSON.stringify(res.body));
});

test('GET /students/admins still resolves and is not shadowed by /:id/detail', async () => {
  const { orgA } = ctx.fixtures;

  // The regression this guards: Express matches in registration order, so a
  // '/:id'-prefixed route declared above '/admins' would capture the literal
  // path and answer "Invalid student id" instead of the teacher list.
  const res = await get('/students/admins', { token: tokenFor(orgA.owner) });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.admins));
  assert.ok(res.body.admins.some((admin) => Number(admin.id) === orgA.teacher1.id));
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test('courses lists what the student is enrolled in, and nothing else', async () => {
  const { orgA } = ctx.fixtures;

  await courseWithAssignment(orgA.teacher1, orgA.student1a, { title: 'Enrolled Course' });
  // A second course on the same teacher, with a DIFFERENT student enrolled.
  // A missing student_id filter would leak it into student1a's page.
  await courseWithAssignment(orgA.teacher1, orgA.student1b, { title: 'Sibling Course' });

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.courses.count, 1);
  assert.equal(res.body.courses.courses[0].title, 'Enrolled Course');
  assert.equal(res.body.courses.courses[0].teacher_name, 'Teacher One');
  assert.ok(res.body.courses.courses[0].enrolled_at);
});

test('homework lists published assignments with course title, and excludes drafts', async () => {
  const { orgA } = ctx.fixtures;

  await courseWithAssignment(orgA.teacher1, orgA.student1a, {
    title: 'Theory',
    assignmentTitle: 'Published work',
    status: 'published'
  });
  await courseWithAssignment(orgA.teacher1, orgA.student1a, {
    title: 'Aural',
    assignmentTitle: 'Draft work',
    status: 'draft'
  });

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.homework.count, 1);

  const [assignment] = res.body.homework.assignments;
  assert.equal(assignment.title, 'Published work');
  assert.equal(assignment.course_title, 'Theory');
  // Untouched homework carries an explicit null rather than an absent key, so
  // the client branches on presence instead of on a magic status string.
  assert.equal(assignment.submission, null);

  const titles = res.body.homework.assignments.map((row) => row.title);
  assert.ok(!titles.includes('Draft work'));
});

test('homework carries the latest attempt when the student has submitted', async () => {
  const { orgA } = ctx.fixtures;

  const { assignmentId } = await courseWithAssignment(orgA.teacher1, orgA.student1a, {
    assignmentTitle: 'Etude no. 4'
  });

  // Two attempts. submissions keeps every attempt as its own row, so the
  // endpoint must report attempt 2 and must not emit the assignment twice.
  await ctx.pool.query(
    'INSERT INTO submissions (org_id, assignment_id, student_id, attempt, body) VALUES (?, ?, ?, ?, ?)',
    [orgA.id, assignmentId, orgA.student1a.id, 1, 'First try.']
  );
  await ctx.pool.query(
    "INSERT INTO submissions (org_id, assignment_id, student_id, attempt, body, status) VALUES (?, ?, ?, ?, ?, 'reviewed')",
    [orgA.id, assignmentId, orgA.student1a.id, 2, 'Second try.']
  );

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.homework.count, 1, 'one row per assignment, not one per attempt');

  const [assignment] = res.body.homework.assignments;
  assert.equal(assignment.submission.attempt, 2);
  assert.equal(assignment.submission.status, 'reviewed');
  assert.ok(assignment.submission.id);
});

test("another student's submission does not attach to this student's homework", async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/courses', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Shared Course' }
  });
  const courseId = created.body.course.id;

  for (const student of [orgA.student1a, orgA.student1b]) {
    await post(`/courses/${courseId}/enrollments`, {
      token: tokenFor(orgA.teacher1),
      body: { student_id: student.id }
    });
  }

  const assignment = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Shared homework' }
  });
  const assignmentId = assignment.body.assignment.id;
  await patch(`/courses/${courseId}/assignments/${assignmentId}`, {
    token: tokenFor(orgA.teacher1),
    body: { status: 'published' }
  });

  // Only student1b hands work in.
  await ctx.pool.query(
    'INSERT INTO submissions (org_id, assignment_id, student_id, attempt, body) VALUES (?, ?, ?, ?, ?)',
    [orgA.id, assignmentId, orgA.student1b.id, 1, 'Done.']
  );

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.homework.count, 1);
  // The assignment is student1a's (they are enrolled), but the submission is
  // not -- it belongs to their classmate.
  assert.equal(res.body.homework.assignments[0].submission, null);
});

test('bookings lists only this student’s sessions', async () => {
  const { orgA } = ctx.fixtures;

  await insertBooking(orgA.teacher1, orgA.student1a, '2026-09-01 10:00:00');
  await insertBooking(orgA.teacher1, orgA.student1a, '2026-09-08 10:00:00', 'cancelled');
  await insertBooking(orgA.teacher1, orgA.student1b, '2026-09-02 11:00:00');

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.bookings.count, 2);
  assert.ok(
    res.body.bookings.bookings.every((booking) => Number(booking.student_id) === orgA.student1a.id)
  );
  assert.ok(res.body.bookings.bookings.every((booking) => booking.student_name === 'Student One A'));
});

test('videos lists only this student’s videos', async () => {
  const { orgA } = ctx.fixtures;

  await insertVideo(orgA.teacher1, orgA.student1a, 'Week one practice');
  await insertVideo(orgA.teacher1, orgA.student1b, 'Not theirs');

  const res = await get(`/students/${orgA.student1a.id}/detail`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.videos.count, 1);
  assert.equal(res.body.videos.videos[0].title, 'Week one practice');
  // serializeVideo withholds the internal S3 key; playback goes through the
  // dedicated endpoint.
  assert.equal(res.body.videos.videos[0].s3_key, undefined);
});

test('an owner sees the same sections for a student on any teacher’s roster', async () => {
  const { orgA } = ctx.fixtures;

  await courseWithAssignment(orgA.teacher2, orgA.student2a, { title: 'Teacher Two Course' });
  await insertBooking(orgA.teacher2, orgA.student2a, '2026-09-03 09:00:00');

  const res = await get(`/students/${orgA.student2a.id}/detail`, {
    token: tokenFor(orgA.owner)
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.courses.count, 1);
  assert.equal(res.body.homework.count, 1);
  assert.equal(res.body.bookings.count, 1);
});
