const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { validateParams, validateQuery } = require('../middleware/validate');
const { notificationIdParamSchema, listNotificationsQuerySchema } = require('../schemas/notifications.schema');

const router = express.Router();

// Shapes a `notifications` row for API responses — plain passthrough, no
// joins needed (unlike messages/comments there's no other-user info to
// bring in here).
function serializeNotification(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
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
      let query = 'SELECT * FROM notifications WHERE user_id = ?';
      const params = [req.user.id];

      if (req.query.unread) {
        query += ' AND read_at IS NULL';
      }
      query += ' ORDER BY created_at DESC';

      const [rows] = await pool.query(query, params);

      const [countRows] = await pool.query(
        'SELECT COUNT(*) AS unread_count FROM notifications WHERE user_id = ? AND read_at IS NULL',
        [req.user.id]
      );

      res.status(200).json({
        notifications: rows.map(serializeNotification),
        unread_count: countRows[0].unread_count
      });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id/read',
  requireAuth(),
  validateParams(notificationIdParamSchema),
  async (req, res, next) => {
    try {
      const [result] = await pool.query(
        'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ? AND read_at IS NULL',
        [req.params.id, req.user.id]
      );

      res.status(200).json({ status: 'ok', updated_count: result.affectedRows });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
