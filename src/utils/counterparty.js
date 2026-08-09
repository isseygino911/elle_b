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
    // The adminId on the access token is a CLAIM, not a fact. It was true when
    // the token was minted; a student reassigned since (0e0255c added exactly
    // that feature) still holds a token naming their previous teacher, and
    // nothing re-reads it. Trusting it directly produced a notification
    // addressed to a user who may be in a different organization entirely --
    // and the read path, filtering on user_id alone, would then show it to
    // them.
    //
    // So the token is used as a HINT and confirmed against the database, with
    // the actor's own org as the fence. One indexed primary-key lookup; the
    // saved query was not worth a cross-tenant leak.
    const [rows] = await executor.query(
      'SELECT admin_id FROM users WHERE id = ? AND org_id = ?',
      [actor.id, actor.orgId]
    );

    const adminId = rows[0]?.admin_id ?? null;
    if (!adminId) {
      return null;
    }

    // The teacher must also be inside the actor's organization. admin_id is a
    // plain self-FK with no org predicate, so a cross-org value is
    // representable -- stale data, a reassignment bug, or a future bulk import
    // could all produce one.
    const [adminRows] = await executor.query(
      'SELECT id FROM users WHERE id = ? AND org_id = ?',
      [adminId, actor.orgId]
    );

    return adminRows.length > 0 ? adminId : null;
  }

  // A teacher, owner or manager is acting -> notify the student the action
  // was about. studentId may legitimately be null (e.g. a comment on a class
  // video that is not assigned to any student), in which case nobody is
  // notified.
  //
  // Callers reach here only after assertStudentInScope / loadAuthorizedVideo,
  // both of which already fence on org, so studentId is trusted at this point.
  return studentId ?? null;
}

// Everyone who should hear about an action, not just the obvious counterparty.
//
// BUG B: resolveCounterparty answers "the other party", which is right for a
// two-person interaction and wrong when an OWNER acts. An owner may message or
// book on behalf of any student in the org; resolveCounterparty then returns
// that student, and the student's actual teacher -- whose message thread was
// just written to, or whose calendar was just filled -- is never told. The
// teacher discovers it by chance.
//
// Returns a de-duplicated array, never including the actor: being notified of
// one's own action is noise, and the four original call sites avoided it only
// because their role logic happened to make it unreachable, not by any guard.
//
// Managers are absent by construction rather than by exclusion: scopeFor
// (utils/scope.js) throws for managers on every row-level endpoint, so a
// manager never reaches a notification-producing path at all.
async function resolveRecipients(executor, { actor, studentId }) {
  const recipients = new Set();

  const counterparty = await resolveCounterparty(executor, { actor, studentId });
  if (counterparty) {
    recipients.add(String(counterparty));
  }

  // When somebody other than the student's own teacher acts on that student,
  // the teacher is a second interested party.
  if (actor.role !== ROLES.STUDENT && studentId) {
    const [rows] = await executor.query(
      'SELECT admin_id FROM users WHERE id = ? AND org_id = ?',
      [studentId, actor.orgId]
    );

    const teacherId = rows[0]?.admin_id ?? null;
    if (teacherId) {
      recipients.add(String(teacherId));
    }
  }

  // Never notify the actor about their own action.
  recipients.delete(String(actor.id));

  return [...recipients].map(Number);
}

module.exports = { resolveCounterparty, resolveRecipients };
