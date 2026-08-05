// Resolves WHOSE CALENDAR a scheduling request refers to.
//
// Both the availability routes (a teacher's recurring weekly windows) and the
// bookings routes (concrete appointments carved out of those windows) need to
// answer the same question, and getting a different answer in the two places
// is what makes an owner's availability edits invisible to the booking flow.
// Hence one shared resolver rather than a copy in each router.
//
// The teacher is NEVER taken from an unvalidated request field -- only from
// the caller's own identity, or from an explicit admin_id that is verified to
// be an admin in the caller's organization. A client-supplied, unchecked admin
// id would let somebody book time on, or rewrite the schedule of, a teacher
// who is not theirs.
//
// Sends its own error response and returns null when it cannot resolve, so
// callers only need `if (adminId === null) return;`.

const pool = require('../db/pool');
const { ROLES } = require('../constants/roles');

async function resolveCalendarAdminId(req, res) {
  if (req.user.role === ROLES.STUDENT) {
    if (!req.user.adminId) {
      res.status(400).json({ status: 'error', message: 'You are not assigned to a teacher yet' });
      return null;
    }
    return req.user.adminId;
  }

  // A teacher always acts on their own calendar.
  if (req.user.role === ROLES.ADMIN) {
    return req.user.id;
  }

  // An owner has no calendar of their own -- they act on behalf of a specific
  // teacher, who must be named explicitly. Without this branch an owner's
  // writes would land on their own user id, producing rows that no booking
  // query ever reads.
  if (req.user.role === ROLES.OWNER) {
    const requested = req.query.admin_id || req.body?.admin_id;
    if (!requested) {
      res.status(400).json({ status: 'error', message: 'admin_id is required' });
      return null;
    }

    const [rows] = await pool.query(
      "SELECT id FROM users WHERE id = ? AND role = 'admin' AND org_id = ?",
      [requested, req.user.orgId]
    );
    if (!rows[0]) {
      res
        .status(400)
        .json({ status: 'error', message: 'admin_id does not reference a teacher in your organization' });
      return null;
    }
    return rows[0].id;
  }

  // Manager, or anything unrecognized. A manager is aggregates-only and has no
  // business reading or writing an individual teacher's calendar.
  res.status(403).json({ status: 'error', message: 'Forbidden' });
  return null;
}

module.exports = { resolveCalendarAdminId };
