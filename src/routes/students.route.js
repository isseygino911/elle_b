const express = require('express');
const pool = require('../db/pool');
const { scopeFor } = require('../utils/scope');
const { assertStudentInScope } = require('../utils/students');
const { requireCapability } = require('../middleware/auth');
const { CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateParams } = require('../middleware/validate');
const { studentIdParamSchema } = require('../schemas/students.schema');
const { computeStudentSurveyScores, computeAllStudentsProgress } = require('./students.helpers');

const router = express.Router();

// Shapes a `users` row (role='student') for API responses — plain
// passthrough, used to populate the tutor-facing student-selection
// dropdowns.
function serializeStudent(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email
  };
}

router.get('/', requireCapability(CAN_READ_STUDENT_DETAIL), async (req, res, next) => {
  try {
    // An admin sees only their own roster; an owner sees the whole
    // organization. Previously this returned EVERY student in the database.
    const scope = scopeFor(req.user, { org: 'org_id', admin: 'admin_id' });
    const [rows] = await pool.query(
      `SELECT id, name, email FROM users WHERE role = 'student' AND ${scope.sql} ORDER BY name`,
      scope.params
    );

    res.status(200).json({ students: rows.map(serializeStudent) });
  } catch (err) {
    next(err);
  }
});

// Every student's overall survey completion in one call — backs the
// Students list panel's per-row badge. Same computeAllStudentsProgress used
// by the dashboard's student_progress widget (dashboard.route.js), so both
// surfaces agree on what "completion" means.
router.get('/progress', requireCapability(CAN_READ_STUDENT_DETAIL), async (req, res, next) => {
  try {
    const students = await computeAllStudentsProgress(req.user);
    res.status(200).json({ students });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:id/scores',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateParams(studentIdParamSchema),
  async (req, res, next) => {
    try {
      // assertStudentInScope, not a bare id lookup: an admin must not be able
      // to read a peer's student's scores by guessing an id, and nobody may
      // reach across organizations. A student not in scope is reported as 404,
      // indistinguishable from "does not exist".
      const student = await assertStudentInScope(req.user, req.params.id);

      if (!student) {
        return res.status(404).json({ status: 'error', message: 'Student not found' });
      }

      const scores = await computeStudentSurveyScores(student.id, student.org_id);

      res.status(200).json({ student: serializeStudent(student), scores });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
