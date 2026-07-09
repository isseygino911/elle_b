// Shared boolean existence check for role='student' users. Callers decide
// their own response (status code/message) when a student doesn't exist —
// this module only answers the yes/no question.

const pool = require('../db/pool');

async function studentExists(studentId) {
  const [rows] = await pool.query(
    "SELECT id FROM users WHERE id = ? AND role = 'student'",
    [studentId]
  );

  return rows.length > 0;
}

module.exports = { studentExists };
