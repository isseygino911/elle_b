// Shared by submissions.route.js, so the answer to "which assignment may this
// caller submit to, or read submissions of" is decided in exactly one place --
// the same reasoning as courses.helpers.js, which this builds on top of.

const pool = require('../db/pool');
const { ROLES } = require('../constants/roles');

function serializeSubmissionFile(row) {
  return {
    id: row.id,
    submission_id: row.submission_id,
    kind: row.kind,
    original_filename: row.original_filename,
    content_type: row.content_type,
    // BIGINT UNSIGNED arrives as a string through this driver. A JSON "1024"
    // where the client expects 1024 is the kind of difference that only shows
    // up in a comparison -- same reasoning as serializeCourse's student_count.
    size_bytes: Number(row.size_bytes),
    duration_sec: row.duration_sec === null ? null : Number(row.duration_sec),
    created_at: row.created_at
  };
}

// s3_key is deliberately NOT serialized.
//
// It is an internal storage address, and every legitimate use of a file goes
// through the download/preview endpoints, which presign it after re-checking
// the caller's scope. Handing the raw key to a client invites a future frontend
// to build its own URL from it, which would be a URL nobody authorized.
function serializeSubmission(row, files = []) {
  return {
    id: row.id,
    org_id: row.org_id,
    assignment_id: row.assignment_id,
    student_id: row.student_id,
    student_name: row.student_name ?? undefined,
    assignment_title: row.assignment_title ?? undefined,
    attempt: Number(row.attempt),
    body: row.body,
    status: row.status,
    feedback: row.feedback,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    files: files.map(serializeSubmissionFile)
  };
}

// Loads an assignment the caller may act on, together with the parent course,
// or null.
//
// Every endpoint in the submissions route begins here. A submission is only
// reachable through an assignment, which is only reachable through a course --
// so this composes the course rule rather than restating it. There is no
// submission-specific authorization rule to get wrong.
//
// A STUDENT reaches an assignment through enrollment, and only a PUBLISHED one.
// A draft is a teacher's unfinished thinking (assignments.route.js says the
// same at greater length), and a student who could submit against a draft would
// be handing in work for homework that was never set.
//
// A MANAGER never arrives here: they are in neither CAN_MANAGE_COURSES nor
// CAN_SUBMIT_WORK, so requireCapability turns them away at every endpoint.
async function loadAssignmentInScope(user, assignmentId, executor = pool) {
  if (user.role === ROLES.STUDENT) {
    const [rows] = await executor.query(
      `SELECT a.*, c.admin_id AS course_admin_id, c.title AS course_title
         FROM assignments a
         JOIN courses c ON c.id = a.course_id
        WHERE a.id = ? AND a.org_id = ? AND a.status = 'published'
          AND EXISTS (
            SELECT 1 FROM course_enrollments e
             WHERE e.course_id = a.course_id AND e.student_id = ?
          )`,
      [assignmentId, user.orgId, user.id]
    );
    return rows[0] ?? null;
  }

  // Teacher and owner. Not scopeFor(): assignments carries no admin_id of its
  // own -- ownership is the parent course's -- so the fence rides on
  // c.admin_id through the join. An owner sees every course in their org, a
  // teacher only their own.
  const conditions = ['a.id = ?', 'a.org_id = ?'];
  const params = [assignmentId, user.orgId];

  if (user.role === ROLES.ADMIN) {
    conditions.push('c.admin_id = ?');
    params.push(user.id);
  } else if (user.role !== ROLES.OWNER) {
    // Fail closed on an unrecognized role, matching scopeFor's default branch.
    // The failure mode is "no rows", never "all rows".
    return null;
  }

  const [rows] = await executor.query(
    `SELECT a.*, c.admin_id AS course_admin_id, c.title AS course_title
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
      WHERE ${conditions.join(' AND ')}`,
    params
  );
  return rows[0] ?? null;
}

// The files belonging to a set of submissions, grouped by submission id.
//
// One query for the whole page rather than one per submission: a teacher's
// review queue lists every attempt by every enrolled student, and a per-row
// query there is the N+1 that turns a 20-student class into 20 round trips.
async function fetchFilesBySubmission(submissionIds, executor = pool) {
  const grouped = new Map();

  if (submissionIds.length === 0) {
    return grouped;
  }

  const [rows] = await executor.query(
    'SELECT * FROM submission_files WHERE submission_id IN (?) ORDER BY id ASC',
    [submissionIds]
  );

  for (const row of rows) {
    const key = Number(row.submission_id);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(row);
  }

  return grouped;
}

module.exports = {
  serializeSubmission,
  serializeSubmissionFile,
  loadAssignmentInScope,
  fetchFilesBySubmission
};
