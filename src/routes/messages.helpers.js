// Shared helper for the /messages/:studentId routes — resolves and
// authorizes the thread identified by the URL's studentId.
//
// A message thread's identity changed under multi-tenancy: it used to be
// keyed by student_id alone, because there was exactly one possible other
// party. It is now the (student_id, admin_id) pair — see migration 0023.
//
// Authorization is delegated entirely to assertStudentInScope, which
// enforces: same organization, and for a teacher, their own roster only.
// The previous version checked only `role === 'student' && id !== own id`,
// which meant every non-student — including, once the role existed, a
// manager — could read any student's private thread.
//
// Existence and ownership are both reported as 404 "Thread not found" so a
// caller cannot distinguish "not yours" from "doesn't exist", which would
// otherwise let them enumerate student ids across tenants.

const { assertStudentInScope } = require('../utils/students');

async function loadAuthorizedThread(req, res) {
  const { studentId } = req.params;

  const student = await assertStudentInScope(req.user, studentId);

  if (!student) {
    res.status(404).json({ status: 'error', message: 'Thread not found' });
    return null;
  }

  // adminId is the thread's teacher side: for a student it is their own
  // teacher, and for a teacher acting on their roster it is themselves.
  return { studentId: student.id, adminId: student.admin_id, orgId: student.org_id };
}

module.exports = { loadAuthorizedThread };
