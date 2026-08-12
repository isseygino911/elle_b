const express = require('express');
const pool = require('../db/pool');
const { scopeFor } = require('../utils/scope');
const { assertStudentInScope } = require('../utils/students');
const { requireCapability, requireRole } = require('../middleware/auth');
const { ROLES, CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateParams, validateBody } = require('../middleware/validate');
const { studentIdParamSchema, reassignStudentSchema } = require('../schemas/students.schema');

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
