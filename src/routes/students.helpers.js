// The section queries behind GET /students/:id/detail.
//
// WHY THESE LIVE HERE AND NOT IN THE ROUTE
// students.route.js composes them; this file knows how to fetch each one. Same
// split as dashboard.route.js (which composes) over bookings.helpers.js /
// assignments.helpers.js (which fetch) -- a section is a query plus a shape,
// and the route should read as a list of sections rather than as SQL.
//
// ON AUTHORIZATION
// Every function here takes a student id that the CALLER HAS ALREADY BEEN
// CLEARED FOR by assertStudentInScope in the route. None of them re-derives
// that permission, and none of them may be called without it -- they filter on
// student_id, which answers "whose rows are these", not "may you see them".
//
// org_id is still pinned in every query. assertStudentInScope has already
// fenced the student to the caller's organization, so this is defence in
// depth: it matches how 0023/0024 pushed org_id onto every content table
// precisely so no read has to reach the tenancy boundary through a join.

const pool = require('../db/pool');

// The courses a student is enrolled in.
//
// Membership comes from course_enrollments, not from users.admin_id -- 0031's
// header spells out why those are different sets: a teacher's roster answers
// "who do I teach", this table answers "who is doing this coursework", and a
// student on the roster may be in no course at all.
//
// Ordered newest-first so the current course leads. enrolled_at is carried
// through from the join row because "in this course since" is the one fact the
// courses table itself cannot supply.
async function fetchStudentCourses(studentId, orgId) {
  const [rows] = await pool.query(
    `SELECT c.*, u.name AS teacher_name, e.created_at AS enrolled_at
       FROM course_enrollments e
       JOIN courses c ON c.id = e.course_id
       JOIN users u ON u.id = c.admin_id
      WHERE e.student_id = ? AND e.org_id = ?
      ORDER BY c.created_at DESC, c.id DESC`,
    [studentId, orgId]
  );
  return rows;
}

// The homework a student actually owes, with the state of their latest attempt.
//
// PUBLISHED ONLY. A draft is unpublished work in progress -- it has not been
// fanned out to anyone (see updateAssignment's publish step) and must never
// appear on a student's page, not even to the teacher looking at it, because
// this list is "what this student has been given".
//
// The EXISTS subquery is the same shape fetchAssignmentsDue and
// loadCourseInScope use: assignments has no student_id, so enrollment in the
// parent course is what makes an assignment this student's.
//
// THE LEFT JOIN IS THE POINT. submissions keeps every attempt as its own row
// (0033), so the join is pinned to MAX(attempt) for this student -- without
// that a student with three attempts produces three rows for one assignment.
// Fetching it here rather than per-assignment is what keeps this one query
// instead of the N+1 that a per-row "have they submitted?" would cost.
async function fetchStudentAssignments(studentId, orgId) {
  const [rows] = await pool.query(
    `SELECT a.*, c.title AS course_title,
            s.id AS submission_id, s.status AS submission_status,
            s.attempt AS submission_attempt, s.created_at AS submitted_at
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
       LEFT JOIN submissions s
              ON s.assignment_id = a.id
             AND s.student_id = ?
             AND s.attempt = (
                   SELECT MAX(s2.attempt) FROM submissions s2
                    WHERE s2.assignment_id = a.id AND s2.student_id = ?
                 )
      WHERE a.status = 'published'
        AND a.org_id = ?
        AND EXISTS (
              SELECT 1 FROM course_enrollments e
               WHERE e.course_id = a.course_id AND e.student_id = ?
            )
      ORDER BY a.due_date IS NULL, a.due_date ASC, a.id ASC`,
    [studentId, studentId, orgId, studentId]
  );
  return rows;
}

// A student's practice videos. Mirrors the column list GET /videos selects so
// the two agree on what a video row is; serializeVideo drops s3_key either way.
async function fetchStudentVideos(studentId, orgId) {
  const [rows] = await pool.query(
    `SELECT id, type, student_id, title, duration_sec, status, uploaded_by, created_at
       FROM videos
      WHERE student_id = ? AND org_id = ?
      ORDER BY created_at DESC, id DESC`,
    [studentId, orgId]
  );
  return rows;
}

// Shapes one row from fetchStudentAssignments. The submission_* columns are
// flattened into a nested `submission` (null when untouched) so the client can
// branch on presence rather than on a magic status string.
//
// A LEFT JOIN miss yields NULL for every joined column, so submission_id is the
// honest test for "has this student handed anything in".
function serializeStudentAssignment(row, serializeAssignment) {
  return {
    ...serializeAssignment(row),
    course_title: row.course_title ?? null,
    submission:
      row.submission_id === null || row.submission_id === undefined
        ? null
        : {
            id: row.submission_id,
            status: row.submission_status,
            // Number(): MariaDB returns this through the driver as a string,
            // the same reason serializeCourse casts student_count.
            attempt: Number(row.submission_attempt),
            submitted_at: row.submitted_at
          }
  };
}

module.exports = {
  fetchStudentCourses,
  fetchStudentAssignments,
  fetchStudentVideos,
  serializeStudentAssignment
};
