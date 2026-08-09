const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { validateParams, validateQuery } = require('../middleware/validate');
const { notificationIdParamSchema, listNotificationsQuerySchema } = require('../schemas/notifications.schema');

const router = express.Router();

// Hard ceiling on one page. The dashboard polls this endpoint every 15
// seconds (DashboardPage.jsx:42) and nothing ever deletes a notification, so
// an unbounded query re-transferred a user's entire history on every poll --
// growing forever for anyone who does not mark things read.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

// Shapes a `notifications` row for API responses.
//
// title/body/actor_id are included because a row is now self-describing
// (migration 0026). Before that the client received only an enum and a
// pointer, which is why the dashboard rendered the literal string "comment"
// next to a raw timestamp -- there was nothing else to show.
function serializeNotification(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    actor_id: row.actor_id,
    actor_name: row.actor_name ?? null,
    type: row.type,
    title: row.title,
    body: row.body,
    ref_id: row.ref_id,
    read_at: row.read_at,
    created_at: row.created_at
  };
}

router.get(
  '/',
  requireAuth(),
  validateQuery(listNotificationsQuerySchema),
  async (req, res, next) => {
    try {
      // org_id is filtered alongside user_id even though user_id is already
      // the tightest possible scope. Defence in depth: with the write-side
      // fence in notifications.helpers.js a cross-org row cannot be created
      // through the app, and this ensures one would not be SHOWN even if it
      // arrived by some other route (a manual insert, a restored backup, a
      // future bulk import). Before this, org_id on this table was write-only
      // -- stamped on insert and never read back.
      const conditions = ['n.user_id = ?', 'n.org_id = ?'];
      const params = [req.user.id, req.user.orgId];

      if (req.query.unread) {
        conditions.push('n.read_at IS NULL');
      }

      const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
      const offset = Number(req.query.offset) || 0;

      // actor_name is joined rather than denormalised onto the row: a user's
      // display name can change, and a notification should not preserve a
      // stale one. LEFT JOIN because actor_id is nullable -- historical rows
      // predate the column, and fk_notifications_actor_id is ON DELETE SET
      // NULL, so a departed teacher leaves the notification intact but
      // unattributed.
      const [rows] = await pool.query(
        `SELECT n.*, u.name AS actor_name
           FROM notifications n
           LEFT JOIN users u ON u.id = n.actor_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const [countRows] = await pool.query(
        'SELECT COUNT(*) AS unread_count FROM notifications WHERE user_id = ? AND org_id = ? AND read_at IS NULL',
        [req.user.id, req.user.orgId]
      );

      res.status(200).json({
        notifications: rows.map(serializeNotification),
        unread_count: countRows[0].unread_count,
        limit,
        offset
      });
    } catch (err) {
      next(err);
    }
  }
);

// Mark every unread notification read in one call.
//
// Must be declared before '/:id/read', or the ':id' pattern captures the
// literal string "read-all" and the request fails param validation instead of
// routing here.
router.patch('/read-all', requireAuth(), async (req, res, next) => {
  try {
    const [result] = await pool.query(
      'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND org_id = ? AND read_at IS NULL',
      [req.user.id, req.user.orgId]
    );

    res.status(200).json({ status: 'ok', updated_count: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id/read',
  requireAuth(),
  validateParams(notificationIdParamSchema),
  async (req, res, next) => {
    try {
      const [result] = await pool.query(
        'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ? AND org_id = ? AND read_at IS NULL',
        [req.params.id, req.user.id, req.user.orgId]
      );

      res.status(200).json({ status: 'ok', updated_count: result.affectedRows });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
