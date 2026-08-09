// Shared by assignments.route.js and dashboard.route.js's "homework due"
// section, so the role-scoping rule lives in exactly one place.

const pool = require('../db/pool');
const { ROLES } = require('../constants/roles');
const { scopeFor } = require('../utils/scope');
const { formatDateOnly } = require('./tasks.helpers');

// TINYINT(1) comes back from mysql2 as 0/1, not false/true. Serializing it raw
// would hand the client a number where the schema accepts a boolean, so a
// round-trip (GET, toggle one flag, PATCH the whole object back) would fail
// validation on the two flags the teacher never touched.
function toBool(value) {
  return Boolean(value);
}

function serializeAssignment(row) {
  return {
    id: row.id,
    org_id: row.org_id,
    course_id: row.course_id,
    course_title: row.course_title ?? undefined,
    title: row.title,
    body: row.body,
    reference_url: row.reference_url,
    // DATE column -- see formatDateOnly's own header for why this cannot be
    // left to Date.prototype.toJSON.
    due_date: formatDateOnly(row.due_date),
    allowed_attempts: row.allowed_attempts === null ? null : Number(row.allowed_attempts),
    accepts_text: toBool(row.accepts_text),
    accepts_files: toBool(row.accepts_files),
    accepts_recording: toBool(row.accepts_recording),
    max_recording_sec: Number(row.max_recording_sec),
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at
  };
}

// Published assignments with a due date in the near future, scoped to the
// caller. Drives the dashboard's "homework due" section.
//
// A STUDENT sees the assignments of courses they are ENROLLED in -- not the
// assignments of their teacher's other courses. Enrollment is the membership
// fact (courses has no student_id column to fence on), the same reasoning as
// loadCourseInScope.
//
// A MANAGER never reaches this. The caller in dashboard.route.js branches them
// to the aggregates-only dashboard before this runs, and scopeFor throws for
// them besides.
async function fetchAssignmentsDue(user, { daysAhead = 14 } = {}) {
  const conditions = [
    "a.status = 'published'",
    'a.due_date IS NOT NULL',
    // CURDATE(), not UTC_TIMESTAMP(): due_date is a calendar day (0032's
    // header), so "due today" must stay on the list for the whole of today
    // rather than expiring at midnight UTC.
    'a.due_date >= CURDATE()',
    'a.due_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)'
  ];
  const params = [daysAhead];

  if (user.role === ROLES.STUDENT) {
    conditions.push('a.org_id = ?');
    params.push(user.orgId);
    conditions.push(
      'EXISTS (SELECT 1 FROM course_enrollments e WHERE e.course_id = a.course_id AND e.student_id = ?)'
    );
    params.push(user.id);
  } else {
    // assignments has no admin_id of its own -- ownership is the parent
    // course's. Scoping on c.admin_id via the join is what keeps a teacher's
    // dashboard to their own courses while an owner sees the whole org.
    const scope = scopeFor(user, { org: 'a.org_id', admin: 'c.admin_id' });
    conditions.push(scope.sql);
    params.push(...scope.params);
  }

  const [rows] = await pool.query(
    `SELECT a.*, c.title AS course_title
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.due_date ASC, a.id ASC`,
    params
  );

  return rows;
}

module.exports = { serializeAssignment, fetchAssignmentsDue };
