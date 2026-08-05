const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const { studentIdParamSchema, sendMessageSchema } = require('../schemas/messages.schema');
const { loadAuthorizedThread } = require('./messages.helpers');
const { resolveCounterparty } = require('../utils/counterparty');
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

// All three routes are requireAuth(), NOT requireCapability, deliberately: a
// student is a legitimate participant in their own thread, and
// CAN_READ_STUDENT_DETAIL is {owner, admin} — gating on it would break
// messaging for every student.
//
// The per-student boundary is enforced by loadAuthorizedThread ->
// assertStudentInScope instead, which denies managers unconditionally, denies
// across organizations, and denies a teacher reaching outside their roster. A
// manager therefore gets 404 rather than 403 here; that is the intended
// convention for "this row isn't yours" and confirms nothing about existence.
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

      // Keyed on the (student_id, admin_id) PAIR, not student_id alone: a
      // thread belongs to one student AND one teacher (migration 0023). The
      // INSERT below has always written admin_id; this read used to ignore
      // it, so reassigning a student to a new teacher handed that teacher the
      // previous teacher's entire private history with them.
      const [rows] = await pool.query(
        `SELECT m.*, u.name AS sender_name, u.role AS sender_role
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.student_id = ? AND m.admin_id = ? AND m.org_id = ?
         ORDER BY m.created_at ASC, m.id ASC`,
        [thread.studentId, thread.adminId, thread.orgId]
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
          'INSERT INTO messages (org_id, admin_id, student_id, sender_id, body) VALUES (?, ?, ?, ?, ?)',
          [thread.orgId, thread.adminId, thread.studentId, req.user.id, req.body.body]
        );
        messageId = insertResult.insertId;

        const recipientId = await resolveCounterparty(connection, {
          actor: req.user,
          studentId: thread.studentId
        });

        if (recipientId) {
          await insertNotification(connection, { orgId: req.user.orgId, userId: recipientId, type: 'message', refId: messageId });
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

      // Same pair key as the read above — without admin_id, marking your own
      // thread read would clear the unread flags on another teacher's thread
      // with the same student.
      const [result] = await pool.query(
        `UPDATE messages SET read_at = NOW()
          WHERE student_id = ? AND admin_id = ? AND org_id = ?
            AND sender_id != ? AND read_at IS NULL`,
        [thread.studentId, thread.adminId, thread.orgId, req.user.id]
      );

      res.status(200).json({ status: 'ok', updated_count: result.affectedRows });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
