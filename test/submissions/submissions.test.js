'use strict';

// Phase 4 -- submissions.
//
// A submission is the most private row in this application: it is a named
// student's own work, and the files hanging off it are their recorded
// performance. So the boundaries asserted here are the plan's must-not-regress
// list, applied to the one table where a leak would hand over media rather
// than metadata:
//
//   1. A manager is refused on every endpoint. They outrank a student and a
//      teacher both, which is exactly what a rank-based gate would get wrong.
//   2. A student reads only their OWN submission -- asserted against the RAW
//      JSON of a list response, not a rendered view.
//   3. A teacher of another roster cannot reach the work.
//   4. Cross-org is invisible in both directions.
//   5. A student cannot mint a signed URL for another student's recording.
//
// And the feature's own claim, asserted explicitly because it is the thing
// Canvas structurally cannot do: body AND an attachment AND a recording, all
// landing on ONE submission in ONE request.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { get, post, patch, del } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

// POST .../submissions calls s3.headSubmissionObject to confirm each declared
// upload really landed before writing a row. That is a genuine network call,
// so it is stubbed -- the same module-export stubbing videos.test.js uses, and
// for the same reason: it keeps production code free of test seams.
//
// The stub is keyed by s3_key so one call can return different answers for
// different files, which is what the mixed-parts and wrong-type tests need.
let s3;
let realHead;
let headResponses = new Map();
let defaultHead = { contentType: 'application/pdf', contentLength: 2048 };

function stubHead() {
  // eslint-disable-next-line global-require
  s3 = s3 || require('../../src/services/s3');
  if (!realHead) {
    realHead = s3.headSubmissionObject;
  }
  s3.headSubmissionObject = async (key) =>
    headResponses.has(key) ? headResponses.get(key) : defaultHead;
}

function headFor(key, result) {
  stubHead();
  headResponses.set(key, result);
}

test.beforeEach(() => {
  headResponses = new Map();
  defaultHead = { contentType: 'application/pdf', contentLength: 2048 };
  stubHead();
});

test.afterEach(() => {
  if (s3 && realHead) {
    s3.headSubmissionObject = realHead;
  }
});

const RECORDING_HEAD = { contentType: 'video/webm', contentLength: 4096 };

async function tableRows(table) {
  const [rows] = await ctx.pool.query(`SELECT * FROM ${table} ORDER BY id ASC`);
  return rows;
}

async function notificationsOfType(type) {
  const [rows] = await ctx.pool.query(
    'SELECT * FROM notifications WHERE type = ? ORDER BY id ASC',
    [type]
  );
  return rows;
}

// Builds a published assignment inside a course owned by `teacher`, with
// `students` enrolled. Goes through the API rather than straight to SQL so the
// fixture exercises the same paths the tests are about.
async function publishedAssignment(teacher, students, overrides = {}) {
  const created = await post('/courses', {
    token: tokenFor(teacher),
    body: { title: 'Grade 3 Repertoire' }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const courseId = created.body.course.id;

  for (const student of students) {
    // eslint-disable-next-line no-await-in-loop
    const enrolled = await post(`/courses/${courseId}/enrollments`, {
      token: tokenFor(teacher),
      body: { student_id: student.id }
    });
    assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  }

  const assignment = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(teacher),
    body: { title: 'Scales, Friday', accepts_recording: true, ...overrides }
  });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.body));
  const assignmentId = assignment.body.assignment.id;

  const published = await patch(`/courses/${courseId}/assignments/${assignmentId}`, {
    token: tokenFor(teacher),
    body: { status: 'published' }
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));

  return { courseId, assignmentId };
}

// A distinct key per call: submission_files.s3_key is UNIQUE, and a duplicate
// is a 409 rather than the 201 most of these tests assert on.
let keyCounter = 0;
function uniqueKey(name = 'work.pdf') {
  keyCounter += 1;
  return `submissions/key-${keyCounter}/${name}`;
}

async function submit(student, assignmentId, body) {
  return post(`/assignments/${assignmentId}/submissions`, {
    token: tokenFor(student),
    body
  });
}

// ---------------------------------------------------------------------------
// The feature's central claim
// ---------------------------------------------------------------------------

test('one submission carries body AND an attachment AND a recording together', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const attachmentKey = uniqueKey('scales.pdf');
  const recordingKey = uniqueKey('recording.webm');
  headFor(recordingKey, RECORDING_HEAD);

  const created = await submit(orgA.student1a, assignmentId, {
    body: 'Practised twice daily.',
    files: [
      { kind: 'attachment', original_filename: 'scales.pdf', s3_key: attachmentKey },
      {
        kind: 'recording',
        original_filename: 'recording.webm',
        s3_key: recordingKey,
        duration_sec: 120
      }
    ]
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));

  const submission = created.body.submission;
  assert.equal(submission.body, 'Practised twice daily.');
  assert.equal(submission.attempt, 1);
  assert.equal(submission.status, 'submitted');

  // All three parts on ONE row. This is the assertion the whole feature exists
  // for -- Canvas's model makes submission types mutually exclusive, so the
  // equivalent request there is unrepresentable.
  assert.equal(submission.files.length, 2);

  const attachment = submission.files.find((file) => file.kind === 'attachment');
  const recording = submission.files.find((file) => file.kind === 'recording');

  assert.ok(attachment, 'expected an attachment row');
  assert.ok(recording, 'expected a recording row');
  assert.equal(recording.duration_sec, 120);
  assert.equal(recording.content_type, 'video/webm');

  // Size and type come from S3's HeadObject, not from the request -- the client
  // never sent either.
  assert.equal(attachment.size_bytes, 2048);
  assert.equal(recording.size_bytes, 4096);

  // s3_key is never serialized: it is an internal storage address, and every
  // legitimate use goes through the presigning endpoints.
  assert.equal(attachment.s3_key, undefined);
  assert.equal(recording.s3_key, undefined);
});

test('submitting notifies the course teacher exactly once', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  await submit(orgA.student1a, assignmentId, { body: 'Done.' });

  const notifications = await notificationsOfType('submission_received');
  assert.equal(notifications.length, 1);
  assert.equal(Number(notifications[0].user_id), orgA.teacher1.id);
  assert.equal(Number(notifications[0].actor_id), orgA.student1a.id);
});

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

test('a second submission is attempt 2 and attempt 1 survives', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const first = await submit(orgA.student1a, assignmentId, { body: 'First go.' });
  const second = await submit(orgA.student1a, assignmentId, { body: 'Better take.' });

  assert.equal(first.body.submission.attempt, 1);
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.submission.attempt, 2);

  // Every attempt kept -- a resubmission is a new row, not an UPDATE. For
  // instrument practice the progression between takes is the record.
  const rows = await tableRows('submissions');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].body, 'First go.');
  assert.equal(rows[1].body, 'Better take.');
});

test('exceeding allowed_attempts is a 400', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a], {
    allowed_attempts: 1
  });

  await submit(orgA.student1a, assignmentId, { body: 'Only go.' });
  const second = await submit(orgA.student1a, assignmentId, { body: 'Sneaky second.' });

  assert.equal(second.status, 400, JSON.stringify(second.body));
  assert.match(second.body.message, /at most 1 attempt/);

  const rows = await tableRows('submissions');
  assert.equal(rows.length, 1);
});

test('a null allowed_attempts means unlimited', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a], {
    allowed_attempts: null
  });

  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await submit(orgA.student1a, assignmentId, { body: `Take ${i}` });
    assert.equal(result.status, 201, JSON.stringify(result.body));
  }

  const rows = await tableRows('submissions');
  assert.equal(rows.length, 3);
});

// ---------------------------------------------------------------------------
// What an assignment accepts
// ---------------------------------------------------------------------------

test('text is rejected when the assignment does not accept it', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a], {
    accepts_text: false,
    accepts_files: true
  });

  const result = await submit(orgA.student1a, assignmentId, { body: 'Not wanted.' });

  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.message, /written answer/);
  assert.equal((await tableRows('submissions')).length, 0);
});

test('a recording is rejected when the assignment does not accept one', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a], {
    accepts_recording: false
  });

  const key = uniqueKey('recording.webm');
  headFor(key, RECORDING_HEAD);

  const result = await submit(orgA.student1a, assignmentId, {
    files: [
      { kind: 'recording', original_filename: 'recording.webm', s3_key: key, duration_sec: 30 }
    ]
  });

  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.message, /does not accept a recording/);
});

test('a file attachment is rejected when the assignment does not accept files', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a], {
    accepts_files: false
  });

  const result = await submit(orgA.student1a, assignmentId, {
    files: [{ kind: 'attachment', original_filename: 'work.pdf', s3_key: uniqueKey() }]
  });

  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.message, /file attachments/);
});

test('a submission empty in every part is a 400', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const result = await submit(orgA.student1a, assignmentId, { body: '   ', files: [] });

  // The schema trims, so a body of spaces is indistinguishable from no body --
  // otherwise a student could consume an attempt while handing in nothing.
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.message, /must include/);
  assert.equal((await tableRows('submissions')).length, 0);
});

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

test('an over-length recording is a 400', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a], {
    max_recording_sec: 60
  });

  const key = uniqueKey('long.webm');
  headFor(key, RECORDING_HEAD);

  const result = await submit(orgA.student1a, assignmentId, {
    files: [
      { kind: 'recording', original_filename: 'long.webm', s3_key: key, duration_sec: 61 }
    ]
  });

  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.message, /at most 60 seconds/);
});

test('a recording with a null duration is accepted', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a], {
    max_recording_sec: 60
  });

  const key = uniqueKey('short.webm');
  headFor(key, RECORDING_HEAD);

  // A MediaRecorder WebM carries no duration in its header, so a sub-second
  // take legitimately reports null rather than 0. Rejecting it would refuse a
  // real recording; coercing it to 0 would record a measurement nobody made.
  const result = await submit(orgA.student1a, assignmentId, {
    files: [
      { kind: 'recording', original_filename: 'short.webm', s3_key: key, duration_sec: null }
    ]
  });

  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.submission.files[0].duration_sec, null);
});

test('a recording that is not video/webm is a 400', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const key = uniqueKey('not-a-take.mp4');
  headFor(key, { contentType: 'video/mp4', contentLength: 4096 });

  // The recorder produces video/webm and nothing else, so a kind='recording'
  // row of another type did not come from it -- and its duration_sec cannot be
  // trusted against the cap.
  const result = await submit(orgA.student1a, assignmentId, {
    files: [
      { kind: 'recording', original_filename: 'not-a-take.mp4', s3_key: key, duration_sec: 10 }
    ]
  });

  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.message, /must be video\/webm/);
});

// ---------------------------------------------------------------------------
// Upload verification
// ---------------------------------------------------------------------------

test('a declared file that never landed in S3 is a 400', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const key = uniqueKey('ghost.pdf');
  headFor(key, null);

  const result = await submit(orgA.student1a, assignmentId, {
    files: [{ kind: 'attachment', original_filename: 'ghost.pdf', s3_key: key }]
  });

  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.message, /retry the upload/);

  // Nothing partially written: the row would otherwise point at an object that
  // does not exist.
  assert.equal((await tableRows('submissions')).length, 0);
  assert.equal((await tableRows('submission_files')).length, 0);
});

test('a replayed s3_key is a 409', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const key = uniqueKey('same.pdf');
  const files = [{ kind: 'attachment', original_filename: 'same.pdf', s3_key: key }];

  const first = await submit(orgA.student1a, assignmentId, { files });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const second = await submit(orgA.student1a, assignmentId, { files });
  assert.equal(second.status, 409, JSON.stringify(second.body));

  // The rolled-back attempt left no parent row behind.
  assert.equal((await tableRows('submissions')).length, 1);
});

// ---------------------------------------------------------------------------
// The reviewed lock
// ---------------------------------------------------------------------------

test('a student edits their own submission before it is reviewed', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const created = await submit(orgA.student1a, assignmentId, { body: 'First thoughts.' });
  const submissionId = created.body.submission.id;

  const edited = await patch(`/submissions/${submissionId}`, {
    token: tokenFor(orgA.student1a),
    body: { body: 'Revised thoughts.' }
  });

  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.submission.body, 'Revised thoughts.');
});

test('editing after review is a 409', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const created = await submit(orgA.student1a, assignmentId, { body: 'Bar 14 is shaky.' });
  const submissionId = created.body.submission.id;

  const reviewed = await patch(`/submissions/${submissionId}/review`, {
    token: tokenFor(orgA.teacher1),
    body: { feedback: 'Watch bar 14.' }
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));

  const edited = await patch(`/submissions/${submissionId}`, {
    token: tokenFor(orgA.student1a),
    body: { body: 'Bar 14 is now completely different.' }
  });

  // The lock. Without it the teacher's "watch bar 14" ends up attached to work
  // that has since changed underneath it.
  assert.equal(edited.status, 409, JSON.stringify(edited.body));

  const rows = await tableRows('submissions');
  assert.equal(rows[0].body, 'Bar 14 is shaky.');
});

test('a review notifies the student, and re-reviewing does not notify twice', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const created = await submit(orgA.student1a, assignmentId, { body: 'Done.' });
  const submissionId = created.body.submission.id;

  const reviewed = await patch(`/submissions/${submissionId}/review`, {
    token: tokenFor(orgA.teacher1),
    body: { feedback: 'Nicely shaped.' }
  });

  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal(reviewed.body.submission.status, 'reviewed');
  assert.equal(reviewed.body.submission.feedback, 'Nicely shaped.');
  assert.equal(Number(reviewed.body.submission.reviewed_by), orgA.teacher1.id);
  assert.ok(reviewed.body.submission.reviewed_at, 'expected reviewed_at to be set');

  let notifications = await notificationsOfType('submission_reviewed');
  assert.equal(notifications.length, 1);
  assert.equal(Number(notifications[0].user_id), orgA.student1a.id);

  // A teacher fixing a typo in their feedback must not send a second "your
  // work was reviewed".
  const again = await patch(`/submissions/${submissionId}/review`, {
    token: tokenFor(orgA.teacher1),
    body: { feedback: 'Nicely shaped — watch the rests.' }
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));

  notifications = await notificationsOfType('submission_reviewed');
  assert.equal(notifications.length, 1);

  const rows = await tableRows('submissions');
  assert.equal(rows[0].feedback, 'Nicely shaped — watch the rests.');
});

test('a student cannot review their own submission', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const created = await submit(orgA.student1a, assignmentId, { body: 'Done.' });

  const reviewed = await patch(`/submissions/${created.body.submission.id}/review`, {
    token: tokenFor(orgA.student1a),
    body: { feedback: 'Excellent work, me.' }
  });

  assert.equal(reviewed.status, 403, JSON.stringify(reviewed.body));
});

// ---------------------------------------------------------------------------
// THE PRIVACY BOUNDARY
// ---------------------------------------------------------------------------

test('a student listing submissions sees only their own, in the raw JSON', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [
    orgA.student1a,
    orgA.student1b
  ]);

  await submit(orgA.student1a, assignmentId, { body: 'Student A private work.' });
  await submit(orgA.student1b, assignmentId, { body: 'Student B private work.' });

  const asStudentA = await get(`/assignments/${assignmentId}/submissions`, {
    token: tokenFor(orgA.student1a)
  });

  assert.equal(asStudentA.status, 200, JSON.stringify(asStudentA.body));
  assert.equal(asStudentA.body.submissions.length, 1);
  assert.equal(Number(asStudentA.body.submissions[0].student_id), orgA.student1a.id);

  // Asserted against the serialized response, not the parsed shape: the thing
  // that must never happen is another student's prose appearing anywhere in
  // the bytes this endpoint returns.
  const raw = JSON.stringify(asStudentA.body);
  assert.ok(!raw.includes('Student B private work.'), 'leaked another student\'s work');
  assert.ok(!raw.includes('Student One B'), "leaked another student's name");
});

test('a student cannot read another student\'s submission by id', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [
    orgA.student1a,
    orgA.student1b
  ]);

  const created = await submit(orgA.student1b, assignmentId, { body: 'Private.' });

  const stolen = await get(`/submissions/${created.body.submission.id}`, {
    token: tokenFor(orgA.student1a)
  });

  // 404 rather than 403: a distinguishable error lets a caller enumerate ids.
  assert.equal(stolen.status, 404, JSON.stringify(stolen.body));
});

test("a student cannot query their way into a classmate's work", async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [
    orgA.student1a,
    orgA.student1b
  ]);

  await submit(orgA.student1b, assignmentId, { body: 'Student B private work.' });

  const probed = await get(
    `/assignments/${assignmentId}/submissions?student_id=${orgA.student1b.id}`,
    { token: tokenFor(orgA.student1a) }
  );

  // The student_id filter is a teacher's affordance. For a student the scope
  // predicate overrides it rather than erroring -- the existence of a
  // classmate's work is not theirs to probe.
  assert.equal(probed.status, 200, JSON.stringify(probed.body));
  assert.equal(probed.body.submissions.length, 0);
  assert.ok(!JSON.stringify(probed.body).includes('Student B private work.'));
});

test('a student cannot mint a signed URL for another student\'s recording', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [
    orgA.student1a,
    orgA.student1b
  ]);

  const key = uniqueKey('private-take.webm');
  headFor(key, RECORDING_HEAD);

  const created = await submit(orgA.student1b, assignmentId, {
    files: [
      { kind: 'recording', original_filename: 'private-take.webm', s3_key: key, duration_sec: 30 }
    ]
  });
  const submissionId = created.body.submission.id;
  const fileId = created.body.submission.files[0].id;

  // The one failure in this feature that would hand over the actual media
  // rather than a row.
  const stolen = await get(`/submissions/${submissionId}/files/${fileId}/preview-url`, {
    token: tokenFor(orgA.student1a)
  });

  assert.equal(stolen.status, 404, JSON.stringify(stolen.body));
});

test('a teacher sees every enrolled student\'s attempts', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [
    orgA.student1a,
    orgA.student1b
  ]);

  await submit(orgA.student1a, assignmentId, { body: 'A work.' });
  await submit(orgA.student1b, assignmentId, { body: 'B work.' });

  const asTeacher = await get(`/assignments/${assignmentId}/submissions`, {
    token: tokenFor(orgA.teacher1)
  });

  assert.equal(asTeacher.status, 200, JSON.stringify(asTeacher.body));
  assert.equal(asTeacher.body.submissions.length, 2);
});

test("a teacher of another roster cannot reach the work", async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const created = await submit(orgA.student1a, assignmentId, { body: 'Private to teacher1.' });

  const listed = await get(`/assignments/${assignmentId}/submissions`, {
    token: tokenFor(orgA.teacher2)
  });
  assert.equal(listed.status, 404, JSON.stringify(listed.body));

  const detail = await get(`/submissions/${created.body.submission.id}`, {
    token: tokenFor(orgA.teacher2)
  });
  assert.equal(detail.status, 404, JSON.stringify(detail.body));

  const reviewed = await patch(`/submissions/${created.body.submission.id}/review`, {
    token: tokenFor(orgA.teacher2),
    body: { feedback: 'Not my student.' }
  });
  assert.equal(reviewed.status, 404, JSON.stringify(reviewed.body));
});

test('an owner sees the work of every course in their own org', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  await submit(orgA.student1a, assignmentId, { body: 'Visible to the owner.' });

  const asOwner = await get(`/assignments/${assignmentId}/submissions`, {
    token: tokenFor(orgA.owner)
  });

  assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body));
  assert.equal(asOwner.body.submissions.length, 1);
});

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

test('a manager is refused on every submissions endpoint', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const key = uniqueKey('take.webm');
  headFor(key, RECORDING_HEAD);

  const created = await submit(orgA.student1a, assignmentId, {
    body: 'Not for the manager.',
    files: [{ kind: 'recording', original_filename: 'take.webm', s3_key: key, duration_sec: 30 }]
  });
  const submissionId = created.body.submission.id;
  const fileId = created.body.submission.files[0].id;
  const token = tokenFor(orgA.manager);

  // A manager outranks a student AND a teacher, so any rank-based gate passes
  // them. Per-student data is their one hard exclusion.
  //
  // Every endpoint, including the two signed-URL ones -- those are the only
  // calls in this file that would hand over the media itself rather than a row.
  const calls = [
    await get(`/assignments/${assignmentId}/submissions`, { token }),
    await get(`/submissions/${submissionId}`, { token }),
    await get(`/submissions/${submissionId}/files/${fileId}/download-url`, { token }),
    await get(`/submissions/${submissionId}/files/${fileId}/preview-url`, { token }),
    await post(`/assignments/${assignmentId}/submissions`, { token, body: { body: 'Mine now.' } }),
    await post(`/assignments/${assignmentId}/submissions/upload-url`, {
      token,
      body: { original_filename: 'x.pdf', content_type: 'application/pdf' }
    }),
    await patch(`/submissions/${submissionId}`, { token, body: { body: 'Edited.' } }),
    await patch(`/submissions/${submissionId}/review`, { token, body: { feedback: 'Seen.' } })
  ];

  for (const result of calls) {
    assert.equal(result.status, 403, JSON.stringify(result.body));
  }

  const raw = JSON.stringify(calls.map((result) => result.body));
  assert.ok(!raw.includes('Not for the manager.'), 'leaked student work to a manager');
});

// ---------------------------------------------------------------------------
// Cross-org
// ---------------------------------------------------------------------------

test('a submission is invisible across organizations', async () => {
  const { orgA, orgB } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const created = await submit(orgA.student1a, assignmentId, { body: 'Org A only.' });
  const submissionId = created.body.submission.id;

  for (const actor of [orgB.owner, orgB.teacher, orgB.student]) {
    // eslint-disable-next-line no-await-in-loop
    const detail = await get(`/submissions/${submissionId}`, { token: tokenFor(actor) });
    assert.equal(detail.status, 404, JSON.stringify(detail.body));

    // eslint-disable-next-line no-await-in-loop
    const listed = await get(`/assignments/${assignmentId}/submissions`, {
      token: tokenFor(actor)
    });
    assert.equal(listed.status, 404, JSON.stringify(listed.body));
  }
});

// ---------------------------------------------------------------------------
// Enrollment and publication as preconditions
// ---------------------------------------------------------------------------

test('a student not enrolled in the course cannot submit', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const result = await submit(orgA.student1b, assignmentId, { body: 'Gatecrashing.' });

  assert.equal(result.status, 404, JSON.stringify(result.body));
  assert.equal((await tableRows('submissions')).length, 0);
});

test('a student cannot submit against a draft assignment', async () => {
  const { orgA } = ctx.fixtures;

  const created = await post('/courses', {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Grade 3 Repertoire' }
  });
  const courseId = created.body.course.id;

  await post(`/courses/${courseId}/enrollments`, {
    token: tokenFor(orgA.teacher1),
    body: { student_id: orgA.student1a.id }
  });

  const assignment = await post(`/courses/${courseId}/assignments`, {
    token: tokenFor(orgA.teacher1),
    body: { title: 'Not published yet' }
  });

  // A draft is the teacher's unfinished thinking. Handing in work against
  // homework that was never set should be impossible, not merely hidden.
  const result = await submit(orgA.student1a, assignment.body.assignment.id, {
    body: 'Early bird.'
  });

  assert.equal(result.status, 404, JSON.stringify(result.body));
});

test('a teacher cannot submit work', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  // A submission is attributed to its student_id and counts against that
  // student's attempt limit, so a teacher submitting would either be writing
  // under someone else's name or creating a submission with no author.
  const result = await submit(orgA.teacher1, assignmentId, { body: 'Teaching by example.' });

  assert.equal(result.status, 403, JSON.stringify(result.body));
});

// ---------------------------------------------------------------------------
// Upload URL
// ---------------------------------------------------------------------------

test('a student gets an upload URL for an assignment they can reach', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  let capturedKey = null;
  // eslint-disable-next-line global-require
  const service = require('../../src/services/s3');
  const realCreate = service.createSubmissionUploadPost;
  service.createSubmissionUploadPost = async (key) => {
    capturedKey = key;
    return { url: 'https://s3.example.test/bucket', fields: { key } };
  };

  try {
    const result = await post(`/assignments/${assignmentId}/submissions/upload-url`, {
      token: tokenFor(orgA.student1a),
      body: { original_filename: 'my take.webm', content_type: 'video/webm' }
    });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.match(result.body.upload.s3_key, /^submissions\//);
    assert.ok(result.body.allowed_content_types.includes('video/webm'));
    // The filename is sanitized into the key rather than interpolated raw.
    assert.ok(!capturedKey.includes(' '), 'expected the filename to be sanitized');
  } finally {
    service.createSubmissionUploadPost = realCreate;
  }
});

// ---------------------------------------------------------------------------
// What deleting the course takes with it
// ---------------------------------------------------------------------------
//
// The delete path was written in Phase 3, when nothing could create a
// submission file and nothing could create a submission notification. Both are
// now real, so the two things the FK cascade cannot reach are tested here
// rather than in the courses suite -- these assertions need the actual submit
// path to have run.

test('deleting a course deletes the S3 objects its submissions pointed at', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId, assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  const attachmentKey = uniqueKey('scales.pdf');
  const recordingKey = uniqueKey('take.webm');
  headFor(recordingKey, RECORDING_HEAD);

  await submit(orgA.student1a, assignmentId, {
    body: 'Done.',
    files: [
      { kind: 'attachment', original_filename: 'scales.pdf', s3_key: attachmentKey },
      { kind: 'recording', original_filename: 'take.webm', s3_key: recordingKey, duration_sec: 30 }
    ]
  });

  const deletedKeys = [];
  // eslint-disable-next-line global-require
  const service = require('../../src/services/s3');
  const realDelete = service.deleteSubmissionObject;
  service.deleteSubmissionObject = async (key) => {
    deletedKeys.push(key);
  };

  try {
    const removed = await del(`/courses/${courseId}?confirm=true`, {
      token: tokenFor(orgA.teacher1)
    });

    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.deleted.file_count, 2);

    // The rows cascade away with the course; the objects do not. Without this
    // the bucket keeps every recording of every deleted course forever.
    assert.deepEqual(deletedKeys.sort(), [attachmentKey, recordingKey].sort());
  } finally {
    service.deleteSubmissionObject = realDelete;
  }

  assert.equal((await tableRows('submission_files')).length, 0);
  assert.equal((await tableRows('submissions')).length, 0);
});

test('deleting a course clears the submission notifications it produced', async () => {
  const { orgA } = ctx.fixtures;
  const { courseId, assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  // Force the two id spaces apart before anything is submitted.
  //
  // Without this the first assignment and the first submission are BOTH id 1,
  // so a cleanup that matches submission notifications against assignment ids
  // passes by coincidence. Verified: with the ids left colliding, reverting the
  // route to the single-IN-list version leaves this test green. The offset is
  // what makes the assertion mean anything.
  await ctx.pool.query('ALTER TABLE submissions AUTO_INCREMENT = 500');

  const created = await submit(orgA.student1a, assignmentId, { body: 'Done.' });
  assert.ok(
    Number(created.body.submission.id) > Number(assignmentId),
    'expected the submission id to be distinct from the assignment id'
  );
  await patch(`/submissions/${created.body.submission.id}/review`, {
    token: tokenFor(orgA.teacher1),
    body: { feedback: 'Good.' }
  });

  assert.equal((await notificationsOfType('submission_received')).length, 1);
  assert.equal((await notificationsOfType('submission_reviewed')).length, 1);

  const removed = await del(`/courses/${courseId}?confirm=true`, {
    token: tokenFor(orgA.teacher1)
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  // notifications has no FK on ref_id, so nothing cascades these away. They
  // are matched by SUBMISSION id -- assignment_published carries an assignment
  // id and these two carry a submission id, which is why the route cleans them
  // up in separate statements.
  assert.equal((await notificationsOfType('submission_received')).length, 0);
  assert.equal((await notificationsOfType('submission_reviewed')).length, 0);
  assert.equal((await notificationsOfType('assignment_published')).length, 0);

  // The course_deleted notice is the one that must SURVIVE: for a student who
  // submitted, it is the only record they will have that the work existed.
  assert.equal((await notificationsOfType('course_deleted')).length, 1);
});

test('a student cannot get an upload URL for an assignment they cannot reach', async () => {
  const { orgA } = ctx.fixtures;
  const { assignmentId } = await publishedAssignment(orgA.teacher1, [orgA.student1a]);

  // Scope-checked before a key is minted: otherwise any student could request
  // an upload slot against any assignment id.
  const result = await post(`/assignments/${assignmentId}/submissions/upload-url`, {
    token: tokenFor(orgA.student1b),
    body: { original_filename: 'work.pdf', content_type: 'application/pdf' }
  });

  assert.equal(result.status, 404, JSON.stringify(result.body));
});
