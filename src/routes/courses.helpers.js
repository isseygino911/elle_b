// Shared by courses.route.js and assignments.route.js, so the answer to "which
// course may this caller touch" is decided in exactly one place.
//
// Extracted from courses.route.js when assignments arrived: an assignment lives
// inside a course, so every assignment endpoint must first prove the caller may
// reach the parent course. Re-deriving that rule in the assignments route would
// mean two implementations of the same boundary, and the second one would drift.

const pool = require('../db/pool');
const { ROLES } = require('../constants/roles');
const { scopeFor } = require('../utils/scope');
const s3 = require('../services/s3');

function serializeCourse(row) {
  return {
    id: row.id,
    org_id: row.org_id,
    admin_id: row.admin_id,
    teacher_name: row.teacher_name ?? null,
    title: row.title,
    description: row.description,
    status: row.status,
    // Present on list/detail reads, absent on the row echoed straight back
    // after a write. Number() because MariaDB returns COUNT() as a string
    // through this driver, and a JSON "3" where the client expects 3 is the
    // kind of difference that only shows up in a comparison.
    student_count: row.student_count === undefined ? undefined : Number(row.student_count),
    // How much homework a course has actually set: the denominator for a
    // student's progress on the detail read, and the figure the courses list
    // and dashboard show per course. PUBLISHED only -- see the roster query in
    // the GET /courses/:id handler for why a draft must not count against
    // anyone.
    published_assignment_count:
      row.published_assignment_count === undefined ? undefined : Number(row.published_assignment_count),
    created_at: row.created_at
  };
}

// serializeCourse + a presigned thumbnail URL.
//
// Kept SEPARATE from serializeCourse rather than folded into it, because
// signing is async and serializeCourse is not: it is called synchronously in
// six places including `rows.map(serializeCourse)`, and making it async would
// turn that map into an array of promises that JSON.stringify would happily
// serialize as {}. Callers that render a thumbnail opt in by awaiting this;
// everyone else keeps the cheap synchronous shape and pays for no signing.
//
// thumbnail_url is null when there is no key -- the client then falls back to
// the course's status icon, which is the pre-0038 appearance.
async function serializeCourseWithThumbnail(row) {
  return {
    ...serializeCourse(row),
    thumbnail_url: row.thumbnail_key ? await s3.getCourseThumbnailUrl(row.thumbnail_key) : null
  };
}

// Loads one course the caller is allowed to see, or null.
//
// Every read and write funnels through this rather than querying courses
// directly. Callers answer 404 for null without distinguishing "not yours" from
// "does not exist" -- the same reasoning as assertStudentInScope: a
// distinguishable error lets a caller enumerate other tenants' ids.
//
// A STUDENT reaches a course through course_enrollments, not through
// scopeFor's student branch. courses has no student_id column to fence on, and
// passing one that does not exist would be a lie; the EXISTS subquery is the
// honest expression of "a student sees a course they are enrolled in".
//
// A MANAGER never arrives here -- requireCapability(CAN_MANAGE_COURSES) turns
// them away at the door, and scopeFor throws for them besides.
async function loadCourseInScope(user, courseId, executor = pool) {
  if (user.role === ROLES.STUDENT) {
    const [rows] = await executor.query(
      `SELECT c.*, u.name AS teacher_name
         FROM courses c
         JOIN users u ON u.id = c.admin_id
        WHERE c.id = ? AND c.org_id = ?
          AND EXISTS (
            SELECT 1 FROM course_enrollments e
             WHERE e.course_id = c.id AND e.student_id = ?
          )`,
      [courseId, user.orgId, user.id]
    );
    return rows[0] ?? null;
  }

  const scope = scopeFor(user, { org: 'c.org_id', admin: 'c.admin_id' });
  const [rows] = await executor.query(
    `SELECT c.*, u.name AS teacher_name
       FROM courses c
       JOIN users u ON u.id = c.admin_id
      WHERE c.id = ? AND ${scope.sql}`,
    [courseId, ...scope.params]
  );
  return rows[0] ?? null;
}

// The student ids enrolled in a course, in a stable order.
//
// Takes an executor because the publish fan-out reads this INSIDE its
// transaction: the set of recipients must be the set that existed when the
// status flipped, not one an interleaving enrollment could change between the
// read and the notification writes.
async function fetchEnrolledStudentIds(courseId, executor = pool) {
  const [rows] = await executor.query(
    'SELECT student_id FROM course_enrollments WHERE course_id = ? ORDER BY student_id ASC',
    [courseId]
  );
  return rows.map((row) => row.student_id);
}

module.exports = {
  serializeCourse,
  serializeCourseWithThumbnail,
  loadCourseInScope,
  fetchEnrolledStudentIds
};
