// Shared helper for the /messages/:studentId routes — resolves and
// authorizes the thread identified by the URL's studentId. A student may
// only access their own thread; Elle may access any existing student's
// thread. Existence and ownership are both reported as 404 "Thread not
// found" so a student can't distinguish "not yours" from "doesn't exist".

const { studentExists } = require('../utils/students');

async function loadAuthorizedThread(req, res) {
  const { studentId } = req.params;

  if (req.user.role === 'student' && Number(studentId) !== req.user.id) {
    res.status(404).json({ status: 'error', message: 'Thread not found' });
    return null;
  }

  if (!(await studentExists(studentId))) {
    res.status(404).json({ status: 'error', message: 'Thread not found' });
    return null;
  }

  return { studentId };
}

module.exports = { loadAuthorizedThread };
