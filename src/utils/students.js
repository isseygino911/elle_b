// Answers "is this student one the caller is allowed to act on?" -- not
// merely "does this id exist?".
//
// REPLACES the old studentExists(studentId), which ran
//     SELECT id FROM users WHERE id = ? AND role = 'student'
// with no tenancy predicate at all. Under multi-tenancy that is a
// cross-tenant hole: it would happily confirm a student belonging to another
// teacher, or to another organization entirely, letting a caller message
// them, book sessions for them, or upload videos against them by guessing an
// id.
//
// DELIBERATELY RENAMED rather than given an optional `user` parameter. An
// optional parameter can be forgotten at a call site, and that call would
// keep working with its old global behaviour -- silently, and only in
// production. Renaming forces every caller to be revisited.

const pool = require('../db/pool');
const { ROLES } = require('../constants/roles');

// Returns the student row ({ id, org_id, admin_id }) when the caller may act
// on them, or null otherwise.
//
// Callers decide their own response. The existing ones report 404 or 400
// without distinguishing "not yours" from "doesn't exist", which is
// deliberate: a distinguishable error would let a caller enumerate ids
// belonging to other tenants.
//
// `executor` is either the shared pool or an open transaction connection --
// both expose .query() -- so this works identically inside or outside a
// transaction.
async function assertStudentInScope(user, studentId, executor = pool) {
  // name/email are selected so callers can serialize the student directly
  // rather than re-querying. Without them GET /students/:id/scores returned
  // `student: { id, name: undefined, email: undefined }`.
  const [rows] = await executor.query(
    "SELECT id, org_id, admin_id, name, email FROM users WHERE id = ? AND role = 'student'",
    [studentId]
  );

  const student = rows[0];

  if (!student) {
    return null;
  }

  // Tenancy fence first: nobody reaches across organizations, whatever their
  // role.
  if (student.org_id !== user.orgId) {
    return null;
  }

  switch (user.role) {
    // An owner may act on any student in their own organization.
    case ROLES.OWNER:
      return student;

    // A teacher may act only on their own roster. This single check is what
    // makes "other admins can't see my students" true.
    case ROLES.ADMIN:
      return student.admin_id === user.id ? student : null;

    // A student may only ever act on themselves.
    case ROLES.STUDENT:
      return student.id === user.id ? student : null;

    // A manager is aggregates-only and must never reach an individual
    // student, in any context.
    case ROLES.MANAGER:
      return null;

    // Unrecognized role: deny. Same fail-closed posture as utils/scope.js.
    default:
      return null;
  }
}

module.exports = { assertStudentInScope };
