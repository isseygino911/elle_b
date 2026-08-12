const express = require('express');
const pool = require('../db/pool');
const { scopeFor } = require('../utils/scope');
const { assertStudentInScope } = require('../utils/students');
const { requireCapability, requireRole } = require('../middleware/auth');
const { ROLES, CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateParams, validateBody } = require('../middleware/validate');
const { studentIdParamSchema, reassignStudentSchema } = require('../schemas/students.schema');
const { serializeBooking, fetchScopedBookings } = require('./bookings.helpers');
const { serializeCourse } = require('./courses.helpers');
const { serializeAssignment } = require('./assignments.helpers');
const { serializeVideo } = require('./videos.helpers');
const {
  fetchStudentCourses,
  fetchStudentAssignments,
  fetchStudentVideos,
  serializeStudentAssignment
} = require('./students.helpers');

const router = express.Router();

// Shapes a `users` row (role='student') for API responses — plain
// passthrough, used to populate the tutor-facing student-selection
// dropdowns.
//
// admin_id is included so the owner's roster can show who teaches each
// student, and so the reassignment UI can render current state without a
// second request. It is only ever populated for a caller who is already
// permitted to see the roster (CAN_READ_STUDENT_DETAIL), and it identifies a
// teacher, not a student, so it discloses nothing the caller may not see.
function serializeStudent(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    admin_id: row.admin_id ?? null
  };
}

router.get('/', requireCapability(CAN_READ_STUDENT_DETAIL), async (req, res, next) => {
  try {
    // An admin sees only their own roster; an owner sees the whole
    // organization. Previously this returned EVERY student in the database.
    const scope = scopeFor(req.user, { org: 'org_id', admin: 'admin_id' });
    const [rows] = await pool.query(
      `SELECT id, name, email, admin_id FROM users WHERE role = 'student' AND ${scope.sql} ORDER BY name`,
      scope.params
    );

    res.status(200).json({ students: rows.map(serializeStudent) });
  } catch (err) {
    next(err);
  }
});

// The organization's teachers. Backs the owner's "assign this student to a
// teacher" picker -- without it there is no way to discover a valid admin_id
// to send to PATCH /students/:id/admin.
//
// Owner-only, via requireRole rather than requireMinRank: a manager outranks
// an admin but is aggregates-only, and this returns named individuals. It is
// deliberately NOT gated on CAN_READ_STUDENT_DETAIL either -- that set
// includes admin, and one teacher has no business enumerating their peers.
//
// Returns staff, not students, so no student identity is disclosed here.
router.get('/admins', requireRole(ROLES.OWNER), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.name, a.email,
              (SELECT COUNT(*) FROM users s
                WHERE s.admin_id = a.id AND s.role = 'student') AS student_count
         FROM users a
        WHERE a.org_id = ? AND a.role = ?
        ORDER BY a.name`,
      [req.user.orgId, ROLES.ADMIN]
    );

    res.status(200).json({
      admins: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        student_count: Number(row.student_count)
      }))
    });
  } catch (err) {
    next(err);
  }
});

// Everything about one student on one page: who they are, their bookings, the
// courses they are enrolled in, the homework they owe, and their videos.
//
// WHY ONE COMPOSITE ENDPOINT
// Same argument as GET /dashboard: these are independent sections of a single
// screen, and the alternative -- a ?student_id= filter added to /bookings,
// /courses and a new student-scoped assignments list -- would re-derive the
// same "may this caller see this student" boundary in four places, where the
// fourth one drifts. Here it is decided once, below, before any section runs.
//
// DECLARED AFTER /admins ON PURPOSE. Express matches in registration order and
// '/admins' is a literal path; a '/:id'-prefixed route registered above it
// would swallow it and the owner's teacher picker would start 400ing on
// "Invalid student id". The suffix (/detail) makes a collision impossible
// anyway -- belt and braces, since the failure would be silent.
//
// requireCapability(CAN_READ_STUDENT_DETAIL), NOT requireMinRank: a manager
// outranks an admin but is aggregates-only and must never reach a named
// student's rows. See constants/roles.js.
router.get(
  '/:id/detail',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateParams(studentIdParamSchema),
  async (req, res, next) => {
    try {
      // The entire authorization for this endpoint. An owner reaches any
      // student in their org, a teacher only their own roster, and anyone
      // else -- including a student id from another tenant -- gets null.
      //
      // 404 rather than 403, matching PATCH /:id/admin below: a
      // distinguishable "exists but not yours" would let a caller enumerate
      // ids belonging to other organizations.
      const student = await assertStudentInScope(req.user, req.params.id);

      if (!student) {
        return res.status(404).json({ status: 'error', message: 'Student not found' });
      }

      // Concurrent because the sections are independent -- nothing here reads
      // another's result. Every query is fenced on the student's own org_id
      // rather than the caller's, which are equal by the check above.
      const [bookingRows, courseRows, assignmentRows, videoRows] = await Promise.all([
        fetchScopedBookings(req.user, { studentId: student.id }),
        fetchStudentCourses(student.id, student.org_id),
        fetchStudentAssignments(student.id, student.org_id),
        fetchStudentVideos(student.id, student.org_id)
      ]);

      res.status(200).json({
        student: serializeStudent(student),
        bookings: { count: bookingRows.length, bookings: bookingRows.map(serializeBooking) },
        courses: {
          count: courseRows.length,
          courses: courseRows.map((row) => ({
            ...serializeCourse(row),
            enrolled_at: row.enrolled_at
          }))
        },
        homework: {
          count: assignmentRows.length,
          assignments: assignmentRows.map((row) =>
            serializeStudentAssignment(row, serializeAssignment)
          )
        },
        videos: { count: videoRows.length, videos: videoRows.map(serializeVideo) }
      });
    } catch (err) {
      next(err);
    }
  }
);

// Reassign a student to a teacher, or unassign them (admin_id: null).
//
// OWNER-ONLY, and this is the important part. An admin must never reach this:
// they could otherwise pull a peer's student onto their own roster, or dump an
// inconvenient student off it. Reassignment is an ownership decision, so it
// sits with the one role that owns the whole organization.
//
// Migration 0017 names this flow explicitly -- deleting a teacher SET NULLs
// their students "and an owner reassigns them" -- and register (auth.route.js)
// leaves admin_id NULL for an owner-invited student "which is deliberate: the
// owner chooses". This endpoint is where that choice is finally expressible.
router.patch(
  '/:id/admin',
  requireRole(ROLES.OWNER),
  validateParams(studentIdParamSchema),
  validateBody(reassignStudentSchema),
  async (req, res, next) => {
    const { admin_id: adminId } = req.body;

    try {
      // assertStudentInScope rather than a bare id lookup: fences the target
      // to the caller's own organization. Reported as 404 when out of scope,
      // indistinguishable from "does not exist", so ids in other tenants
      // cannot be enumerated from here.
      const student = await assertStudentInScope(req.user, req.params.id);

      if (!student) {
        return res.status(404).json({ status: 'error', message: 'Student not found' });
      }

      // The target teacher must be an admin IN THE CALLER'S OWN ORGANIZATION.
      // Without this check an owner could point one of their students at a
      // teacher in another tenant -- every scoped query downstream keys off
      // admin_id, so that single write would hand a foreign admin an ongoing
      // view of this student's videos, messages and bookings.
      //
      // Verified as one query rather than trusting the FK: the FK only proves
      // the row exists, not that it is an admin or that it is ours.
      if (adminId !== null) {
        const [adminRows] = await pool.query(
          'SELECT id FROM users WHERE id = ? AND org_id = ? AND role = ?',
          [adminId, req.user.orgId, ROLES.ADMIN]
        );

        if (!adminRows[0]) {
          return res
            .status(400)
            .json({ status: 'error', message: 'Not a teacher in this organization' });
        }
      }

      await pool.query('UPDATE users SET admin_id = ? WHERE id = ?', [adminId, student.id]);

      res.status(200).json({
        student: { ...serializeStudent(student), admin_id: adminId }
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
