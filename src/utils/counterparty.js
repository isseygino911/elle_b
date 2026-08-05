// Resolves "the other party" in a student <-> teacher interaction, for
// deciding who receives a notification.
//
// REPLACES src/utils/elleUser.js, whose premise -- "there is exactly one
// teacher in this system, go find her" -- is false under multi-tenancy. That
// helper ran `SELECT id FROM users WHERE role = 'elle' LIMIT 1`, which after
// migration 0017 matches nothing at all (no user holds role 'elle' anymore),
// so every notification it fed would have silently gone nowhere.
//
// Its four call sites -- messages.route.js, bookings.route.js (create and
// cancel) and comments.route.js -- were all asking the same question in the
// same shape:
//
//     req.user.role === 'elle' ? theStudent : await getElleUserId(connection)
//
// i.e. "if I am the teacher, notify the student; otherwise notify the
// teacher." Under the new hierarchy the teacher is no longer a global
// singleton: it is the specific admin that this student belongs to.

const { ROLES } = require('../constants/roles');

// `executor` is either the shared pool or an open transaction connection --
// both expose .query(), so this works identically inside or outside a
// transaction. Every call site is mid-transaction, and passing the connection
// matters: the notification must be written against the same transaction as
// the row that triggered it.
//
// Returns a user id, or null when there is nobody to notify. Callers already
// guard on null (`if (recipientId)`), which is the correct behaviour for an
// unassigned student or a class video with no owning teacher -- the action
// still succeeds, it just notifies nobody.
async function resolveCounterparty(executor, { actor, studentId }) {
  // A student is acting -> notify their own teacher.
  if (actor.role === ROLES.STUDENT) {
    // Prefer the adminId already carried on the access token, so the common
    // case costs no query. It is refreshed from the database on every token
    // refresh, so a reassigned student picks up their new teacher quickly.
    if (actor.adminId) {
      return actor.adminId;
    }

    const [rows] = await executor.query('SELECT admin_id FROM users WHERE id = ?', [actor.id]);
    return rows[0]?.admin_id ?? null;
  }

  // A teacher, owner or manager is acting -> notify the student the action
  // was about. studentId may legitimately be null (e.g. a comment on a class
  // video that is not assigned to any student), in which case nobody is
  // notified.
  return studentId ?? null;
}

module.exports = { resolveCounterparty };
