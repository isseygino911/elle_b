// Shared insert used by every call site that produces a notification --
// messages, comments, bookings (create and cancel), videos, tasks and
// invitations. Always takes an open transaction connection, never the raw
// pool, so a notification is only ever recorded atomically alongside the row
// that triggered it.

// Recipient and organization must agree.
//
// This function previously wrote whatever (orgId, userId) pair it was handed.
// Every call site passes the ACTOR's org, while the recipient comes from
// resolveCounterparty -- so any bug that resolved a recipient outside the
// actor's organization produced a row addressed across a tenancy boundary,
// which the read path (filtering on user_id alone) would then hand over.
//
// The database cannot express this constraint on its own: notifications has an
// FK on user_id and an FK on org_id, but a composite FK would need a unique key
// on users (id, org_id), which is redundant against the primary key and would
// exist solely to serve this one check. So it is enforced here, at the single
// choke point every notification passes through.
//
// It throws rather than silently skipping. A mismatch means an upstream
// resolver is wrong, and since the caller is mid-transaction, throwing rolls
// back the triggering action too. That is the intended blast radius: a message
// that cannot be correctly notified should not be silently half-delivered.
class NotificationScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotificationScopeError';
    // 500, not 4xx: the client did nothing wrong. This is a server-side
    // resolver bug and should surface as one rather than reading like bad
    // input.
    this.status = 500;
  }
}

async function insertNotification(connection, { orgId, userId, type, refId, title = '', body = null, actorId = null }) {
  if (!orgId || !userId) {
    throw new NotificationScopeError('insertNotification requires both orgId and userId');
  }

  const [rows] = await connection.query('SELECT org_id FROM users WHERE id = ?', [userId]);

  if (rows.length === 0) {
    throw new NotificationScopeError(`Notification recipient ${userId} does not exist`);
  }

  // Loose equality: mysql2 may hand back BIGINT columns as strings depending
  // on driver configuration, and a strict comparison would then fail for a
  // perfectly valid pair.
  // eslint-disable-next-line eqeqeq
  if (rows[0].org_id != orgId) {
    throw new NotificationScopeError(
      `Refusing to notify user ${userId} (org ${rows[0].org_id}) on behalf of org ${orgId}`
    );
  }

  await connection.query(
    'INSERT INTO notifications (org_id, user_id, actor_id, type, title, body, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [orgId, userId, actorId, type, title, body, refId]
  );
}

module.exports = { insertNotification, NotificationScopeError };
