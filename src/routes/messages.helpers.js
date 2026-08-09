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

  // A thread needs both sides. An unassigned student has no teacher, so there
  // is no (student_id, admin_id) pair to write -- and messages.admin_id is
  // NOT NULL by migration 0022, which means the INSERT fails at the database
  // and surfaces as a 500. Sending a message as an unassigned student
  // therefore crashed rather than degrading.
  //
  // Reported as 409 rather than 400: the request is well-formed, and the
  // conflict is with the account's current state, which the caller cannot fix
  // by changing the request. bookings.route.js rejects the same precondition
  // at its own entry point; this puts the messages check in the equivalent
  // place instead of letting it reach the driver.
  if (!student.admin_id) {
    res.status(409).json({
      status: 'error',
      message: 'That student is not assigned to a teacher yet'
    });
    return null;
  }

  // adminId is the thread's teacher side: for a student it is their own
  // teacher, and for a teacher acting on their roster it is themselves.
  return { studentId: student.id, adminId: student.admin_id, orgId: student.org_id };
}

module.exports = { loadAuthorizedThread };
