// Shared insert used by the two call sites that produce notifications today
// (messages.route.js, comments.route.js). Always takes an open transaction
// connection — never the raw pool — so a notification is only ever recorded
// atomically alongside the row (message/comment) that triggered it.

async function insertNotification(connection, { orgId, userId, type, refId }) {
  await connection.query(
    'INSERT INTO notifications (org_id, user_id, type, ref_id) VALUES (?, ?, ?, ?)',
    [orgId, userId, type, refId]
  );
}

module.exports = { insertNotification };
