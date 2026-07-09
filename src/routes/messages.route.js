const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const { studentIdParamSchema, sendMessageSchema } = require('../schemas/messages.schema');
const { loadAuthorizedThread } = require('./messages.helpers');
const { getElleUserId } = require('../utils/elleUser');
const { insertNotification } = require('./notifications.helpers');

// Mounted top-level at /messages (not nested under /students) — student_id
// is the thread's own key, not a child resource of some other route.
const router = express.Router();

// Shapes a `messages` row (joined with the sender's users row) for API
// responses.
function serializeMessage(row) {
  return {
    id: row.id,
    student_id: row.student_id,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    sender_role: row.sender_role,
    body: row.body,
    read_at: row.read_at,
    created_at: row.created_at
  };
}

router.get(
  '/:studentId',
  requireAuth(),
  validateParams(studentIdParamSchema),
  async (req, res, next) => {
    try {
      const thread = await loadAuthorizedThread(req, res);
      if (!thread) {
        return;
      }

      const [rows] = await pool.query(
        `SELECT m.*, u.name AS sender_name, u.role AS sender_role
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.student_id = ?
         ORDER BY m.created_at ASC, m.id ASC`,
        [thread.studentId]
      );

      res.status(200).json({ messages: rows.map(serializeMessage) });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:studentId',
  requireAuth(),
  validateParams(studentIdParamSchema),
  validateBody(sendMessageSchema),
  async (req, res, next) => {
    try {
      const thread = await loadAuthorizedThread(req, res);
      if (!thread) {
        return;
      }

      const connection = await pool.getConnection();
      let messageId;

      try {
        await connection.beginTransaction();

        const [insertResult] = await connection.query(
          'INSERT INTO messages (student_id, sender_id, body) VALUES (?, ?, ?)',
          [thread.studentId, req.user.id, req.body.body]
        );
        messageId = insertResult.insertId;

        const recipientId =
          req.user.role === 'elle' ? thread.studentId : await getElleUserId(connection);

        if (recipientId) {
          await insertNotification(connection, { userId: recipientId, type: 'message', refId: messageId });
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      const [rows] = await pool.query(
        `SELECT m.*, u.name AS sender_name, u.role AS sender_role
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.id = ?`,
        [messageId]
      );

      res.status(201).json({ message: serializeMessage(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:studentId/read',
  requireAuth(),
  validateParams(studentIdParamSchema),
  async (req, res, next) => {
    try {
      const thread = await loadAuthorizedThread(req, res);
      if (!thread) {
        return;
      }

      const [result] = await pool.query(
        'UPDATE messages SET read_at = NOW() WHERE student_id = ? AND sender_id != ? AND read_at IS NULL',
        [thread.studentId, req.user.id]
      );

      res.status(200).json({ status: 'ok', updated_count: result.affectedRows });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
