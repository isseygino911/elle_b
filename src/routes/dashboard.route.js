const express = require('express');
const pool = require('../db/pool');
const { scopeFor, ScopeError } = require('../utils/scope');
const { ROLES, CAN_READ_AGGREGATES } = require('../constants/roles');
const { requireAuth } = require('../middleware/auth');
const { serializeTask, fetchScopedTasks } = require('./tasks.helpers');
const { serializeBooking, fetchScopedBookings } = require('./bookings.helpers');
const { serializeAssignment, fetchAssignmentsDue } = require('./assignments.helpers');
const { serializeSubmission, fetchSubmissionsToGrade } = require('./submissions.helpers');

const router = express.Router();

// No status filter: completed tasks stay on the payload so a task a student
// ticks off does not vanish from their teacher's dashboard the moment it is
// done. The list renders them with a check instead of a Mark done button.
// `count` stays the PENDING count -- the card's badge answers "how much is
// outstanding", which a total including finished work would not.
async function buildTasksSection(user) {
  const rows = await fetchScopedTasks(user);
  return {
    count: rows.filter((row) => row.status === 'pending').length,
    tasks: rows.map(serializeTask)
  };
}

async function buildUpcomingBookingsSection(user) {
  const rows = await fetchScopedBookings(user, { status: 'booked', upcoming: true, hoursAhead: 24 });
  return { count: rows.length, bookings: rows.map(serializeBooking) };
}

// Homework falling due, on the EXISTING dashboard payload rather than behind a
// second fetch -- this file composes independent sections, and a due date is
// one more section, not a new endpoint.
//
// Deliberately absent from buildManagerDashboard. Every other section here is
// available to a manager in aggregate form, but an assignment names a course
// whose roster is a list of students, and there is no count of homework that
// tells a manager something they can act on. See CAN_MANAGE_COURSES in
// constants/roles.js for the same argument at greater length.
async function buildAssignmentsDueSection(user) {
  const rows = await fetchAssignmentsDue(user);
  return { count: rows.length, assignments: rows.map(serializeAssignment) };
}

// Homework waiting on review. The teacher's counterpart to
// pending_video_reviews, and TEACHER-ONLY in both directions: a manager must
// never receive a row naming a student (see buildManagerDashboard's own note),
// and for a student "work I handed in that hasn't been marked" is not an
// action they can take -- it is a queue they are waiting on.
//
// serializeSubmission is reused rather than hand-shaping the row so the
// dashboard and the submissions page agree on field names. It emits `files:
// []` here because the query does not join submission_files: the dashboard row
// shows a title, a name and a date, and fetching every attachment to render a
// one-line link would be the N+1 fetchFilesBySubmission exists to avoid.
async function buildSubmissionsToGradeSection(user) {
  const rows = await fetchSubmissionsToGrade(user);
  return { count: rows.length, submissions: rows.map((row) => serializeSubmission(row)) };
}

// The teacher/owner dashboard. Takes the whole `user` (not just an id) because
// every section below scopes on role + orgId + id -- passing a synthesized
// { id, role: 'elle' } would both name a role that no longer exists and drop
// the tenancy fence.
async function buildTeacherDashboard(user) {
  // Videos and messages are scoped the same way the list endpoints are: an
  // admin sees only their own students', an owner sees the whole organization.
  const videoScope = scopeFor(user, { org: 'v.org_id', admin: 'v.admin_id', student: 'v.student_id' });
  const [videoRows] = await pool.query(
    `SELECT v.id, v.student_id, u.name AS student_name, v.title, v.created_at
     FROM videos v
     JOIN users u ON u.id = v.student_id
     WHERE v.type = 'practice' AND v.status = 'pending_review' AND ${videoScope.sql}
     ORDER BY v.created_at ASC`,
    videoScope.params
  );

  const messageScope = scopeFor(user, { org: 'm.org_id', admin: 'm.admin_id', student: 'm.student_id' });
  const [messageRows] = await pool.query(
    `SELECT m.student_id, u.name AS student_name, COUNT(*) AS unread_count
     FROM messages m
     JOIN users u ON u.id = m.student_id
     WHERE m.sender_id != ? AND m.read_at IS NULL AND ${messageScope.sql}
     GROUP BY m.student_id, u.name`,
    [user.id, ...messageScope.params]
  );

  const totalUnread = messageRows.reduce((sum, row) => sum + row.unread_count, 0);

  return {
    role: user.role,
    pending_video_reviews: { count: videoRows.length, videos: videoRows },
    unread_messages: { total_count: totalUnread, by_student: messageRows },
    upcoming_bookings: await buildUpcomingBookingsSection(user),
    tasks: await buildTasksSection(user),
    assignments_due: await buildAssignmentsDueSection(user),
    submissions_to_grade: await buildSubmissionsToGradeSection(user)
  };
}

// The manager dashboard: AGGREGATES ONLY.
//
// This is the entire read surface of the manager role, and the constraint that
// makes the privacy boundary real rather than cosmetic is what this query does
// NOT select -- no student id, no student name, no message body, no video
// title. Only counts, grouped by teacher. Every row here is safe to show
// someone who must never see an individual student.
//
// If you extend this, do not add a column that identifies a student.
//
// GET /dashboard is requireAuth() and branches by role, so this function is
// the boundary rather than a route middleware. Asserting the capability here
// keeps CAN_READ_AGGREGATES enforced rather than merely documented, and means
// a future caller reaching this function by another path still can't produce
// cross-teacher rollups for a role that shouldn't see them.
async function buildManagerDashboard(user) {
  if (!CAN_READ_AGGREGATES.has(user.role)) {
    throw new ScopeError('Not permitted to read aggregate reports');
  }

  const [adminRows] = await pool.query(
    `SELECT
       a.id   AS admin_id,
       a.name AS admin_name,
       (SELECT COUNT(*) FROM users s
         WHERE s.admin_id = a.id AND s.role = 'student')                       AS student_count,
       (SELECT COUNT(*) FROM videos v
         WHERE v.admin_id = a.id AND v.type = 'practice'
           AND v.status = 'pending_review')                                    AS pending_video_reviews,
       (SELECT COUNT(*) FROM bookings b
         WHERE b.admin_id = a.id AND b.status = 'booked'
           AND b.scheduled_at >= UTC_TIMESTAMP())                              AS upcoming_bookings,
       (SELECT COUNT(*) FROM bookings b
         WHERE b.admin_id = a.id AND b.status = 'completed')                   AS completed_sessions,
       (SELECT COUNT(*) FROM messages m
         WHERE m.admin_id = a.id AND m.read_at IS NULL AND m.sender_id != a.id) AS unread_messages
     FROM users a
     WHERE a.org_id = ? AND a.role = 'admin'
     ORDER BY a.name`,
    [user.orgId]
  );

  const [taskRows] = await pool.query(
    `SELECT status, COUNT(*) AS count FROM tasks WHERE org_id = ? GROUP BY status`,
    [user.orgId]
  );

  const tasksByStatus = taskRows.reduce((acc, row) => {
    acc[row.status] = row.count;
    return acc;
  }, {});

  return {
    role: user.role,
    admins: adminRows,
    totals: {
      admin_count: adminRows.length,
      student_count: adminRows.reduce((n, r) => n + Number(r.student_count), 0),
      pending_video_reviews: adminRows.reduce((n, r) => n + Number(r.pending_video_reviews), 0),
      upcoming_bookings: adminRows.reduce((n, r) => n + Number(r.upcoming_bookings), 0),
      tasks: tasksByStatus
    }
  };
}

async function buildStudentDashboard(user) {
  const userId = user.id;
  // Fenced on org_id as well as student_id. Narrowing to the caller's own id
  // already prevents reading anyone else's rows, but both tables carry org_id
  // and every other read in this file goes through the same fence -- leaving
  // these two unfenced is the drift that org_id was added to prevent.
  const [videoRows] = await pool.query(
    `SELECT id, title, created_at FROM videos
     WHERE org_id = ? AND type = 'practice' AND status = 'pending_review' AND student_id = ?
     ORDER BY created_at ASC`,
    [user.orgId, userId]
  );

  const [unreadRows] = await pool.query(
    'SELECT COUNT(*) AS unread_count FROM messages WHERE org_id = ? AND student_id = ? AND sender_id != ? AND read_at IS NULL',
    [user.orgId, userId, userId]
  );

  return {
    role: 'student',
    pending_video_reviews: { count: videoRows.length, videos: videoRows },
    unread_messages: { count: unreadRows[0].unread_count },
    upcoming_bookings: await buildUpcomingBookingsSection(user),
    tasks: await buildTasksSection(user),
    assignments_due: await buildAssignmentsDueSection(user)
  };
}

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    // A manager gets the aggregate dashboard: counts only, never a student
    // name or id. Owners and admins get the teacher dashboard, scoped to what
    // each may see. Anyone else is a student.
    let dashboard;
    if (req.user.role === ROLES.MANAGER) {
      dashboard = await buildManagerDashboard(req.user);
    } else if (req.user.role === ROLES.OWNER || req.user.role === ROLES.ADMIN) {
      dashboard = await buildTeacherDashboard(req.user);
    } else {
      dashboard = await buildStudentDashboard(req.user);
    }

    res.status(200).json(dashboard);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
