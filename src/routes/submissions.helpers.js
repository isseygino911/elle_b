// Shared by submissions.route.js, so the answer to "which assignment may this
// caller submit to, or read submissions of" is decided in exactly one place --
// the same reasoning as courses.helpers.js, which this builds on top of.

const pool = require('../db/pool');
const { ROLES } = require('../constants/roles');
const { scopeFor } = require('../utils/scope');

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
    // Only selected by the dashboard's review-queue query, which needs it to
    // build a /courses/:courseId/assignments/:id link; undefined elsewhere,
    // where the caller already knows the course it is looking at.
    course_id: row.course_id ?? undefined,
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

// Homework waiting on a teacher's review, across every assignment they own.
//
// The counterpart to the dashboard's pending video reviews: videos had a
// review queue on the dashboard and written/recorded homework did not, even
// though `status` distinguishes 'submitted' from 'reviewed' precisely so this
// question can be asked.
//
// Scoped through the parent COURSE, not the submission: `submissions` has no
// admin_id of its own, exactly as `assignments` doesn't -- ownership is the
// course's. fetchAssignmentsDue in assignments.helpers.js scopes the same way
// for the same reason. An owner sees the whole org, an admin only their own
// courses' work, and a manager throws before reaching a query (scope.js), so
// this cannot become a route through which aggregate-only roles read a
// student's name.
//
// Oldest first: a review queue is worked front to back, and the longest wait
// is the one a student is actually feeling.
//
// Served by idx_submissions_assignment_id_status, whose own comment in
// migration 0033 describes this exact query -- "the teacher's review queue,
// and the status filter that finds what still needs looking at".
async function fetchSubmissionsToGrade(user) {
  const scope = scopeFor(user, { org: 's.org_id', admin: 'c.admin_id' });

  const [rows] = await pool.query(
    // a.course_id rides along so the dashboard row can link to
    // /courses/:courseId/assignments/:id -- the real route takes both ids, and
    // a submission row carries only the assignment's.
    `SELECT s.id, s.org_id, s.assignment_id, s.student_id, s.attempt, s.status,
            s.feedback, s.reviewed_by, s.reviewed_at, s.created_at,
            u.name AS student_name, a.title AS assignment_title,
            a.course_id AS course_id
       FROM submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN courses c ON c.id = a.course_id
       JOIN users u ON u.id = s.student_id
      WHERE s.status = 'submitted' AND ${scope.sql}
      ORDER BY s.created_at ASC, s.id ASC`,
    scope.params
  );

  return rows;
}

module.exports = {
  serializeSubmission,
  serializeSubmissionFile,
  loadAssignmentInScope,
  fetchFilesBySubmission,
  fetchSubmissionsToGrade
};
