const express = require('express');
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');
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

router.get('/', requireRole('elle'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name"
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
router.get('/progress', requireRole('elle'), async (req, res, next) => {
  try {
    const students = await computeAllStudentsProgress();
    res.status(200).json({ students });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:id/scores',
  requireRole('elle'),
  validateParams(studentIdParamSchema),
  async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        "SELECT id, name, email FROM users WHERE role = 'student' AND id = ?",
        [req.params.id]
      );
      const student = rows[0];

      if (!student) {
        return res.status(404).json({ status: 'error', message: 'Student not found' });
      }

      const scores = await computeStudentSurveyScores(student.id);

      res.status(200).json({ student: serializeStudent(student), scores });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
