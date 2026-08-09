'use strict';

// Phase 2 -- courses and enrollment.
//
// A course is the first entity in this app whose whole point is to NAME a set
// of students. That makes it per-student data by construction, so the
// boundaries asserted here are the ones the plan lists as must-not-regress:
//
//   1. A manager is refused on every endpoint. They outrank a teacher who is
//      allowed, so any rank-based gate passes them -- the canonical wrong-check
//      test, repeated here because the check is new code.
//   2. A teacher cannot read, edit, or enroll into another teacher's course.
//   3. A teacher cannot enroll a student who is not on their own roster, and
//      neither can an OWNER acting on that teacher's behalf.
//   4. Cross-org is invisible in both directions.
//   5. A student sees a course they are enrolled in, and never the list of who
//      else is in it -- asserted against the raw JSON, not a rendered view.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { get, post, patch, del } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

async function courseRows() {
  const [rows] = await ctx.pool.query('SELECT * FROM courses ORDER BY id ASC');
  return rows;
}

async function enrollmentRows() {
  const [rows] = await ctx.pool.query('SELECT * FROM course_enrollments ORDER BY id ASC');
  return rows;
}

async function enrollmentNotifications() {
  const [rows] = await ctx.pool.query(
    "SELECT * FROM notifications WHERE type = 'course_enrolled' ORDER BY id ASC"
  );
  return rows;
}

async function notificationsOfType(type) {
  const [rows] = await ctx.pool.query(
    'SELECT * FROM notifications WHERE type = ? ORDER BY id ASC',
    [type]
  );
  return rows;
}

async function tableRows(table) {
  const [rows] = await ctx.pool.query(`SELECT * FROM ${table} ORDER BY id ASC`);
  return rows;
}

// Builds a course with one published assignment and one submitted attempt, so
// a delete has real work to destroy. Submissions are inserted directly: the
// submissions route is Phase 4 and does not exist yet, but the table does.
async function courseWithSubmittedWork(teacher, student, title = 'Grade 3 Repertoire') {
  const courseId = await createCourse(teacher, title);

  await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(teacher),
    body: { student_id: student.id }
  });

  const created = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(teacher),
    body: { title: 'Scales, Friday' }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const assignmentId = created.body.assignment.id;

  const published = await patch(`/courses/${courseId}/assignments/${assignmentId}`, {
    token: tokenFor(teacher),
    body: { status: 'published' }
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));

  const [result] = await ctx.pool.query(
    'INSERT INTO submissions (org_id, assignment_id, student_id, attempt, body) VALUES (?, ?, ?, ?, ?)',
    [teacher.orgId, assignmentId, student.id, 1, 'Practised twice daily.']
  );

  return { courseId, assignmentId, submissionId: result.insertId };
}

// Creates a course owned by `teacher` and returns its id. Goes through the API
// rather than straight to SQL so the fixture exercises the same path the tests
// are about -- a course inserted behind the route's back could satisfy an
// assertion the route itself would fail.
async function createCourse(teacher, title = 'Grade 3 Repertoire') {
  const created = await post('/courses', {
    token: tokenFor(teacher),
    body: { title }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.course.id;
}

// ---------------------------------------------------------------------------
// Creating and listing
// ---------------------------------------------------------------------------

test('a teacher creates a course owned by themselves', async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/courses', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Grade 3 Repertoire', description: 'Term one.' }
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.course.title, 'Grade 3 Repertoire');
  assert.equal(created.body.course.description, 'Term one.');
  assert.equal(created.body.course.status, 'active');
  assert.equal(Number(created.body.course.admin_id), orgA.teacher1.id);
  assert.equal(created.body.course.teacher_name, 'Teacher One');
});

test("a teacher cannot create a course owned by another teacher", async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/courses', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Not mine to give', admin_id: orgA.teacher2.id }
  });

  // Accepted, but the supplied admin_id is ignored -- it is the one value a
  // teacher could not have legitimately meant. What matters is that it cannot
  // take effect: the course belongs to the caller.
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(Number(created.body.course.admin_id), orgA.teacher1.id);

  // And teacher2 must not find it in their own list.
  const asTeacher2 = await get('/courses', { token: tokenFor(orgA.teacher2) });
  assert.deepEqual(asTeacher2.body.courses, []);
});

test('an owner must name a teacher, and that teacher must be one of theirs', async () => {
  const { orgA, orgB } = ctx.fixtures;

  const noTeacher = await post('/courses', {
    token: tokenFor(orgA.owner),
    body: { title: 'Whose course?' }
  });
  // An owner owns no roster, so there is no default the server could guess.
  assert.equal(noTeacher.status, 400, JSON.stringify(noTeacher.body));

  const notATeacher = await post('/courses', {
    token: tokenFor(orgA.owner),
    body: { title: 'Hung off a student', admin_id: orgA.student1a.id }
  });
  assert.equal(notATeacher.status, 400, 'a course may not be owned by a student');

  const otherOrg = await post('/courses', {
    token: tokenFor(orgA.owner),
    body: { title: 'Reaching across', admin_id: orgB.teacher.id }
  });
  // THE TENANCY FENCE. Without the org predicate on the teacher lookup, org A's
  // owner hands a course to org B's teacher -- whose students become enrollable
  // through it.
  assert.equal(otherOrg.status, 400, JSON.stringify(otherOrg.body));

  const good = await post('/courses', {
    token: tokenFor(orgA.owner),
    body: { title: 'Properly assigned', admin_id: orgA.teacher1.id }
  });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(Number(good.body.course.admin_id), orgA.teacher1.id);

  assert.equal((await courseRows()).length, 1, 'only the valid create may have written');
});

test('a teacher lists only their own courses; the owner sees the whole org', async () => {
  const { orgA } = ctx.fixtures;

  await createCourse(orgA.teacher1, 'From teacher one');
  await createCourse(orgA.teacher2, 'From teacher two');

  const asTeacher1 = await get('/courses', { token: tokenFor(orgA.teacher1) });
  assert.equal(asTeacher1.status, 200);
  assert.equal(asTeacher1.body.courses.length, 1);
  assert.equal(asTeacher1.body.courses[0].title, 'From teacher one');

  const asOwner = await get('/courses', { token: tokenFor(orgA.owner) });
  assert.equal(asOwner.body.courses.length, 2, 'the owner sees both teachers');
});

test('archived courses are hidden by default and reachable on request', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1, 'Last term');

  const archived = await patch(`/courses/${courseId}`, {
    token: tokenFor(orgA.teacher1),
    body: { status: 'archived' }
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.course.status, 'archived');

  const listed = await get('/courses', { token: tokenFor(orgA.teacher1) });
  assert.deepEqual(listed.body.courses, [], 'finished business is not the default view');

  const explicit = await get('/courses?status=archived', { token: tokenFor(orgA.teacher1) });
  assert.equal(explicit.body.courses.length, 1);

  // Archiving is not deleting: 0030's header argues the row still owns its
  // assignments and submissions.
  assert.equal((await courseRows()).length, 1);
});

// ---------------------------------------------------------------------------
// The teacher-to-teacher boundary
// ---------------------------------------------------------------------------

test("a teacher cannot read or edit another teacher's course", async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);

  const read = await get(`/courses/${courseId}`, { token: tokenFor(orgA.teacher2) });
  // 404, not 403: distinguishing "not yours" from "does not exist" would let a
  // caller enumerate other teachers' course ids.
  assert.equal(read.status, 404, JSON.stringify(read.body));

  const edited = await patch(`/courses/${courseId}`, {
    token: tokenFor(orgA.teacher2),
    body: { title: 'Hijacked' }
  });
  assert.equal(edited.status, 404);

  const [row] = await courseRows();
  assert.equal(row.title, 'Grade 3 Repertoire', 'the title must be untouched');
});

test('a course is invisible across organizations', async () => {
  const { orgA, orgB } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);

  // Org B's owner is an owner, and would see every course in the table if the
  // list query were not org-fenced.
  const listed = await get('/courses', { token: tokenFor(orgB.owner) });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.courses, []);

  const read = await get(`/courses/${courseId}`, { token: tokenFor(orgB.owner) });
  assert.equal(read.status, 404);
});

// ---------------------------------------------------------------------------
// The manager: refused everywhere
// ---------------------------------------------------------------------------

test('a manager is refused on every course endpoint, despite outranking a teacher', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);
  const token = tokenFor(orgA.manager);

  // manager is rank 3, admin is rank 2. Every `rank >= admin` gate lets all six
  // of these through; only a positive allowlist refuses them.
  const attempts = [
    await post('/courses', { token, body: { title: 'From the manager', admin_id: orgA.teacher1.id } }),
    await get('/courses', { token }),
    await get(`/courses/${courseId}`, { token }),
    await patch(`/courses/${courseId}`, { token, body: { title: 'Renamed' } }),
    await post(`/courses/${courseId}/enrollments`, { token, body: { student_id: orgA.student1a.id } }),
    await del(`/courses/${courseId}/enrollments/${orgA.student1a.id}`, { token })
  ];

  for (const [index, attempt] of attempts.entries()) {
    assert.equal(attempt.status, 403, `attempt ${index} must be forbidden: ${JSON.stringify(attempt.body)}`);
  }

  assert.equal((await courseRows()).length, 1, 'no course written or renamed');
  assert.deepEqual(await enrollmentRows(), []);
});

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

test('a teacher enrolls their own student', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);

  const enrolled = await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1a.id }
  });

  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  assert.equal(Number(enrolled.body.enrollment.student_id), orgA.student1a.id);

  const detail = await get(`/courses/${courseId}`, { token: tokenFor(orgA.teacher1) });
  assert.equal(detail.body.students.length, 1);
  assert.equal(detail.body.students[0].name, 'Student One A');
  assert.equal(detail.body.course.student_count, 1);
});

test("a teacher cannot enroll another teacher's student, nor one from another org", async () => {
  const { orgA, orgB } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);
  const token = tokenFor(orgA.teacher1);

  const foreignRoster = await post(`/courses/${courseId}/enrollments`, {
    token,
    body: { student_id: orgA.student2a.id }
  });
  assert.equal(foreignRoster.status, 403, "teacher2's student is not teacher1's to enroll");

  const foreignOrg = await post(`/courses/${courseId}/enrollments`, {
    token,
    body: { student_id: orgB.student.id }
  });
  assert.equal(foreignOrg.status, 403, 'and neither is another organization\'s');

  const orphan = await post(`/courses/${courseId}/enrollments`, {
    token,
    body: { student_id: orgA.orphanStudent.id }
  });
  // A student with no teacher is on no teacher's roster, so a TEACHER still
  // cannot claim them -- assertStudentInScope compares admin_id to the caller
  // and NULL matches nobody. An owner can (see below), which is what keeps them
  // from being permanently unreachable.
  assert.equal(orphan.status, 403, 'a teacher may not claim an unassigned student');

  assert.deepEqual(await enrollmentRows(), []);
});

test('an owner can enroll a student who has no teacher', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);

  // The regression this guards. The old implementation compared the student's
  // admin_id to the course's, and admin_id IS NULL never equals anything -- so
  // an unassigned student could never be enrolled in any course, by anyone,
  // ever. Not a policy, just a consequence of a NULL comparison.
  const enrolled = await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.owner),
    body: { student_id: orgA.orphanStudent.id }
  });

  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  assert.equal(Number(enrolled.body.enrollment.student_id), orgA.orphanStudent.id);

  const rows = await enrollmentRows();
  assert.equal(rows.length, 1);
});

test('an owner may build a course from more than one teacher\'s students', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1, 'Theory, Tuesdays');

  // The group class: student1a is teacher1's, student2a is teacher2's, and both
  // belong in one theory course. This is the case the old implementation could
  // not express at all -- users.admin_id is single-valued, so requiring the
  // student's teacher to BE the course's teacher constrained every course to
  // exactly one roster and made this table redundant.
  for (const student of [orgA.student1a, orgA.student2a]) {
    const enrolled = await post(`/courses/${courseId}/enrollments`, {
      token: tokenFor(orgA.owner),
      body: { student_id: student.id }
    });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  }

  const detail = await get(`/courses/${courseId}`, { token: tokenFor(orgA.teacher1) });
  assert.equal(detail.body.students.length, 2);
  assert.equal(detail.body.course.student_count, 2);
});

test('enrolling a student their teacher does not teach notifies that teacher', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1, 'Theory, Tuesdays');

  // Enrolling grants teacher1 the ability to read student2a's submissions, and
  // neither of them asked for it. Permitted -- an owner assigning a student to
  // a group class is ordinary administration -- but not permitted to be
  // silent. This notification is what replaced the old blanket 403.
  const enrolled = await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.owner),
    body: { student_id: orgA.student2a.id }
  });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));

  const notifications = await enrollmentNotifications();
  assert.equal(notifications.length, 1);
  assert.equal(Number(notifications[0].user_id), orgA.teacher1.id, 'the course teacher is told');
  assert.equal(Number(notifications[0].actor_id), orgA.owner.id);
  assert.equal(Number(notifications[0].ref_id), courseId);
  assert.equal(notifications[0].title, 'Student Two A was added to Theory, Tuesdays');
});

test('enrolling a student their own teacher already teaches notifies nobody', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);

  // No new access is granted -- teacher1 already teaches student1a -- so there
  // is nothing to announce. A notification here would be noise on every
  // ordinary enrollment.
  const byOwner = await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.owner),
    body: { student_id: orgA.student1a.id }
  });
  assert.equal(byOwner.status, 201, JSON.stringify(byOwner.body));

  // And a teacher enrolling their own student is never told about their own
  // action.
  const secondCourse = await createCourse(orgA.teacher1, 'Second course');
  const byTeacher = await post(`/courses/${secondCourse}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1b.id }
  });
  assert.equal(byTeacher.status, 201, JSON.stringify(byTeacher.body));

  assert.deepEqual(await enrollmentNotifications(), []);
});

test('a newly-assigned student can be enrolled by their new teacher', async () => {
  const { orgA } = ctx.fixtures;

  // An owner assigns the previously-unassigned student to teacher1, which is
  // the ordinary route out of the orphan state.
  await ctx.pool.query('UPDATE users SET admin_id = ? WHERE id = ?', [
    orgA.teacher1.id,
    orgA.orphanStudent.id
  ]);

  const courseId = await createCourse(orgA.teacher1);
  const enrolled = await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.orphanStudent.id }
  });

  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));

  // No notification: the student is now on this teacher's roster, so enrolling
  // them grants no access the teacher did not already have.
  assert.deepEqual(await enrollmentNotifications(), []);
});

// ---------------------------------------------------------------------------
// Hard delete
// ---------------------------------------------------------------------------

test('a course with no submitted work deletes without confirmation', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);
  await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1a.id }
  });

  // No gate here on purpose. An enrolled student who never submitted loses
  // nothing, and a confirmation that fires on every delete trains people to
  // click through it.
  const deleted = await del(`/courses/${courseId}`, { token: tokenFor(orgA.teacher1) });

  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted.submission_count, 0);
  assert.deepEqual(await courseRows(), []);
  assert.deepEqual(await enrollmentRows(), []);
});

test('deleting a course with submitted work requires confirmation first', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId } = await courseWithSubmittedWork(orgA.teacher1, orgA.student1a);

  const blocked = await del(`/courses/${courseId}`, { token: tokenFor(orgA.teacher1) });

  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.confirmation_required, true);
  // The teacher is told what they are about to destroy, in the response --
  // counts, not a vague warning.
  assert.equal(blocked.body.submission_count, 1);
  assert.equal(blocked.body.student_count, 1);
  assert.equal(blocked.body.assignment_count, 1);

  // And nothing happened.
  assert.equal((await courseRows()).length, 1);
  assert.equal((await tableRows('submissions')).length, 1);
  assert.equal((await tableRows('assignments')).length, 1);
});

test('confirming deletes the course and everything cascading from it', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId } = await courseWithSubmittedWork(orgA.teacher1, orgA.student1a);

  const deleted = await del(`/courses/${courseId}?confirm=true`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deleted.submission_count, 1);
  assert.equal(deleted.body.deleted.assignment_count, 1);
  assert.equal(deleted.body.deleted.notified_student_count, 1);

  // The FK cascade, verified table by table rather than assumed.
  assert.deepEqual(await courseRows(), []);
  assert.deepEqual(await enrollmentRows(), []);
  assert.deepEqual(await tableRows('assignments'), []);
  assert.deepEqual(await tableRows('submissions'), []);
});

test('students who submitted are told their work was deleted', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId } = await courseWithSubmittedWork(
    orgA.teacher1,
    orgA.student1a,
    'Theory, Tuesdays'
  );

  await del(`/courses/${courseId}?confirm=true`, { token: tokenFor(orgA.teacher1) });

  const told = await notificationsOfType('course_deleted');
  assert.equal(told.length, 1);
  assert.equal(Number(told[0].user_id), orgA.student1a.id);
  assert.equal(Number(told[0].actor_id), orgA.teacher1.id);
  // The title carries the course name because the course itself is gone -- this
  // notification is the only record the student has that the work existed.
  assert.equal(told[0].title, 'Theory, Tuesdays was deleted');
});

test('every enrolled student is told, whether or not they submitted', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId } = await courseWithSubmittedWork(orgA.teacher1, orgA.student1a);

  // student1b is enrolled and hands nothing in. They still had this course on
  // their dashboard and in their course list, so it vanishing without a word
  // would leave them to work out whether it was deleted, hidden, or a bug.
  await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1b.id }
  });

  const deleted = await del(`/courses/${courseId}?confirm=true`, {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(deleted.body.deleted.notified_student_count, 2);

  const told = await notificationsOfType('course_deleted');
  assert.equal(told.length, 2);

  const byStudent = new Map(told.map((row) => [Number(row.user_id), row]));

  // Both are told, and both get the same title -- but the body differs,
  // because the two situations differ. Telling student1b their work was
  // removed would be false; telling student1a the course is merely "no longer
  // available" would understate what happened to theirs.
  assert.equal(
    byStudent.get(orgA.student1a.id).body,
    'The work you submitted for this course has been removed.'
  );
  assert.equal(byStudent.get(orgA.student1b.id).body, 'This course is no longer available.');
});

test('the confirmation counts distinguish enrolled from affected', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId } = await courseWithSubmittedWork(orgA.teacher1, orgA.student1a);

  await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1b.id }
  });

  const blocked = await del(`/courses/${courseId}`, { token: tokenFor(orgA.teacher1) });

  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  // The prompt says how many people LOSE WORK (1), not how many are enrolled
  // (2) -- that is the number that should make a teacher hesitate.
  assert.equal(blocked.body.student_count, 1);
  assert.equal(blocked.body.enrolled_count, 2);
  assert.equal(blocked.body.submission_count, 1);
});

test('a course with no submitted work still notifies its enrolled students', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1, 'Theory, Tuesdays');
  for (const student of [orgA.student1a, orgA.student1b]) {
    await post(`/courses/${courseId}/enrollments`, {
      token: tokenFor(orgA.teacher1),
      body: { student_id: student.id }
    });
  }

  // No confirmation needed -- nothing is destroyed -- but the students still
  // had this course listed, so they are still told it went away.
  const deleted = await del(`/courses/${courseId}`, { token: tokenFor(orgA.teacher1) });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

  const told = await notificationsOfType('course_deleted');
  assert.equal(told.length, 2);
  for (const row of told) {
    assert.equal(row.title, 'Theory, Tuesdays was deleted');
    assert.equal(row.body, 'This course is no longer available.');
  }
});

test('deleting a course clears the notifications that pointed into it', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId } = await courseWithSubmittedWork(orgA.teacher1, orgA.student1a);

  // Publishing produced an assignment_published notification. Its ref_id points
  // at an assignment that is about to cascade away, so leaving it would give the
  // student a permanent link to a 404 -- notifications.ref_id has no FK, so the
  // database cannot clean this up.
  assert.equal((await notificationsOfType('assignment_published')).length, 1);

  await del(`/courses/${courseId}?confirm=true`, { token: tokenFor(orgA.teacher1) });

  assert.deepEqual(await notificationsOfType('assignment_published'), []);
  // But the course_deleted row written during the same transaction survives.
  assert.equal((await notificationsOfType('course_deleted')).length, 1);
});

test('deleting one course leaves another course\'s notifications intact', async () => {
  const { orgA } = ctx.fixtures;

  const keep = await courseWithSubmittedWork(orgA.teacher1, orgA.student1a, 'Keep me');
  const drop = await courseWithSubmittedWork(orgA.teacher1, orgA.student1b, 'Delete me');

  assert.equal((await notificationsOfType('assignment_published')).length, 2);

  await del(`/courses/${drop.courseId}?confirm=true`, { token: tokenFor(orgA.teacher1) });

  // Scoped by ref_id, so only the deleted course's notification goes.
  const remaining = await notificationsOfType('assignment_published');
  assert.equal(remaining.length, 1);
  assert.equal(Number(remaining[0].ref_id), keep.assignmentId);

  assert.equal((await courseRows()).length, 1);
  assert.equal((await tableRows('submissions')).length, 1);
});

test('only the creator may delete a course', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);

  // The owner can see, edit and archive this course, but deleting destroys
  // another person's authored work along with their students' submissions.
  // 403 rather than 404 -- the caller can legitimately see the row, so the
  // refusal is about the verb.
  const byOwner = await del(`/courses/${courseId}?confirm=true`, {
    token: tokenFor(orgA.owner)
  });
  assert.equal(byOwner.status, 403, JSON.stringify(byOwner.body));

  // A peer teacher gets 404 instead: they cannot see the course at all, and
  // saying "forbidden" would confirm it exists.
  const byPeer = await del(`/courses/${courseId}?confirm=true`, {
    token: tokenFor(orgA.teacher2)
  });
  assert.equal(byPeer.status, 404, JSON.stringify(byPeer.body));

  const byManager = await del(`/courses/${courseId}`, { token: tokenFor(orgA.manager) });
  assert.equal(byManager.status, 403, JSON.stringify(byManager.body));

  const byStudent = await del(`/courses/${courseId}`, { token: tokenFor(orgA.student1a) });
  assert.equal(byStudent.status, 403, JSON.stringify(byStudent.body));

  assert.equal((await courseRows()).length, 1, 'the course survives every one of them');
});

test('a course cannot be deleted across organizations', async () => {
  const { orgA, orgB } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);

  for (const user of [orgB.owner, orgB.teacher]) {
    const attempt = await del(`/courses/${courseId}?confirm=true`, { token: tokenFor(user) });
    assert.equal(attempt.status, 404, JSON.stringify(attempt.body));
  }

  assert.equal((await courseRows()).length, 1);
});

test('confirm must be exactly true, not merely present', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId } = await courseWithSubmittedWork(orgA.teacher1, orgA.student1a);

  // 'false' and '0' are non-empty strings, and every non-empty string is
  // truthy in JS. A coercing parse would accept both as consent to destroy
  // data, which is why the schema demands the literal.
  for (const value of ['false', '0', 'yes']) {
    const attempt = await del(`/courses/${courseId}?confirm=${value}`, {
      token: tokenFor(orgA.teacher1)
    });
    assert.equal(attempt.status, 400, `confirm=${value}: ${JSON.stringify(attempt.body)}`);
  }

  assert.equal((await courseRows()).length, 1);
});

test('enrolling the same student twice is a 409, not a second row', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);
  const body = { student_id: orgA.student1a.id };

  const first = await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body
  });
  assert.equal(first.status, 201);

  const second = await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body
  });

  // The unique key doing its job. A duplicate row here would notify the student
  // twice for every assignment published into the course.
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal((await enrollmentRows()).length, 1);
});

test('unenrolling removes the membership row and is idempotent-safe', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);
  await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1a.id }
  });

  const removed = await del(`/courses/${courseId}/enrollments/${orgA.student1a.id}`, {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(await enrollmentRows(), []);

  // Second delete: nothing to remove. 404 rather than a silent 200, so a client
  // is not told it undid something that was never there.
  const again = await del(`/courses/${courseId}/enrollments/${orgA.student1a.id}`, {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(again.status, 404);
});

test("a teacher cannot unenroll a student from another teacher's course", async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);
  await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1a.id }
  });

  const removed = await del(`/courses/${courseId}/enrollments/${orgA.student1a.id}`, {
    token: tokenFor(orgA.teacher2)
  });

  assert.equal(removed.status, 404, JSON.stringify(removed.body));
  assert.equal((await enrollmentRows()).length, 1, 'the enrollment must survive');
});

// ---------------------------------------------------------------------------
// The student's view
// ---------------------------------------------------------------------------

test('a student sees courses they are enrolled in, and no others', async () => {
  const { orgA } = ctx.fixtures;

  const enrolledId = await createCourse(orgA.teacher1, 'Mine');
  await createCourse(orgA.teacher1, 'Also teacher one, not mine');
  await createCourse(orgA.teacher2, "Another teacher's");

  await post(`/courses/${enrolledId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1a.id }
  });

  const listed = await get('/courses', { token: tokenFor(orgA.student1a) });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.courses.length, 1, 'enrollment, not the roster edge, is what admits them');
  assert.equal(listed.body.courses[0].title, 'Mine');

  // Their own teacher's other course is the sharp case: the roster edge points
  // at teacher1, so any implementation that scoped a student by admin_id rather
  // than by enrollment would hand them this one too.
  const notEnrolled = await get('/courses', { token: tokenFor(orgA.student1b) });
  assert.deepEqual(notEnrolled.body.courses, [], 'being taught by teacher1 is not enrollment');
});

test("a student may read their course but never the list of classmates", async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);
  for (const student of [orgA.student1a, orgA.student1b]) {
    await post(`/courses/${courseId}/enrollments`, {
      token: tokenFor(orgA.teacher1),
      body: { student_id: student.id }
    });
  }

  const detail = await get(`/courses/${courseId}`, { token: tokenFor(orgA.student1a) });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.course.title, 'Grade 3 Repertoire');

  // Asserted on the RAW JSON. Hiding the roster in the UI while shipping it in
  // the payload is not a privacy boundary.
  assert.deepEqual(detail.body.students, []);
  const raw = JSON.stringify(detail.body);
  assert.equal(raw.includes('Student One B'), false, 'no classmate identity may appear');
  assert.equal(raw.includes(orgA.student1b.email), false);
});

test('a student cannot create, edit, or enroll into a course', async () => {
  const { orgA } = ctx.fixtures;

  const courseId = await createCourse(orgA.teacher1);
  await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1a.id }
  });

  const token = tokenFor(orgA.student1a);

  // Enrolled, and still not a teacher. Read access to a course must not carry
  // write access to it.
  const created = await post('/courses', { token, body: { title: 'From a student' } });
  assert.equal(created.status, 403, JSON.stringify(created.body));

  const edited = await patch(`/courses/${courseId}`, { token, body: { title: 'Renamed' } });
  assert.equal(edited.status, 403);

  const enrolledSelf = await post(`/courses/${courseId}/enrollments`, {
    token,
    body: { student_id: orgA.student1b.id }
  });
  assert.equal(enrolledSelf.status, 403);

  assert.equal((await courseRows()).length, 1);
  assert.equal((await enrollmentRows()).length, 1);
});

// ---------------------------------------------------------------------------
// Input bounds
// ---------------------------------------------------------------------------

test('course input is bounded, and an empty PATCH is refused', async () => {
  const { orgA } = ctx.fixtures;

  const token = tokenFor(orgA.teacher1);

  const noTitle = await post('/courses', { token, body: { title: '   ' } });
  assert.equal(noTitle.status, 400, 'a course with no name cannot be grouped under');

  const tooLong = await post('/courses', { token, body: { title: 'x'.repeat(256) } });
  assert.equal(tooLong.status, 400, 'title must not exceed the VARCHAR(255) column');

  const courseId = await createCourse(orgA.teacher1);

  // A well-formed request that changes nothing and answers 200 reads to a
  // client as a successful save.
  const empty = await patch(`/courses/${courseId}`, { token, body: {} });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));

  const badStatus = await patch(`/courses/${courseId}`, {
    token,
    body: { status: 'deleted' }
  });
  // 400, not 403: 'deleted' is not a value the column can hold, so this is
  // malformed input rather than a permission failure.
  assert.equal(badStatus.status, 400);

  assert.equal((await courseRows()).length, 1);
});
