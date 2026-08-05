const express = require('express');
const pool = require('../db/pool');
const { CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { requireAuth } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const { videoIdParamSchema } = require('../schemas/videos.schema');
const { createCommentSchema } = require('../schemas/comments.schema');
const { serializeVideo, loadAuthorizedVideo } = require('./videos.helpers');
const { resolveCounterparty } = require('../utils/counterparty');
const { insertNotification } = require('./notifications.helpers');

const router = express.Router({ mergeParams: true });

// Shapes a `comments` row (joined with the author's users row) for API
// responses.
function serializeComment(row) {
  return {
    id: row.id,
    video_id: row.video_id,
    author_id: row.author_id,
    author_name: row.author_name,
    author_role: row.author_role,
    body: row.body,
    timestamp_sec: row.timestamp_sec,
    created_at: row.created_at
  };
}

router.post(
  '/',
  requireAuth(),
  validateParams(videoIdParamSchema),
  validateBody(createCommentSchema),
  async (req, res, next) => {
    try {
      const video = await loadAuthorizedVideo(req, res);
      if (!video) {
        return;
      }

      const connection = await pool.getConnection();
      let commentId;
      let videoRow;

      try {
        await connection.beginTransaction();

        const [insertResult] = await connection.query(
          `INSERT INTO comments (video_id, author_id, body, timestamp_sec)
           VALUES (?, ?, ?, ?)`,
          [video.id, req.user.id, req.body.body, req.body.timestamp_sec ?? null]
        );
        commentId = insertResult.insertId;

        // A teacher (or owner) commenting marks the video reviewed; a student
        // commenting does not. Uses the shared capability set rather than an
        // inline role pair, so a role added later doesn't silently gain the
        // ability to mark work reviewed.
        //
        // `video` came from loadAuthorizedVideo, which is org-fenced, so this
        // can only ever touch a video the caller was already authorized for.
        if (CAN_READ_STUDENT_DETAIL.has(req.user.role)) {
          await connection.query(
            "UPDATE videos SET status = 'reviewed' WHERE id = ? AND status = 'pending_review'",
            [video.id]
          );
        }

        const [videoRows] = await connection.query('SELECT * FROM videos WHERE id = ?', [video.id]);
        videoRow = videoRows[0];

        const recipientId = await resolveCounterparty(connection, {
          actor: req.user,
          studentId: videoRow.student_id
        });

        if (recipientId) {
          await insertNotification(connection, { orgId: req.user.orgId, userId: recipientId, type: 'comment', refId: commentId });
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      const [commentRows] = await pool.query(
        `SELECT c.*, u.name AS author_name, u.role AS author_role
         FROM comments c
         JOIN users u ON u.id = c.author_id
         WHERE c.id = ?`,
        [commentId]
      );

      res.status(201).json({
        comment: serializeComment(commentRows[0]),
        video: serializeVideo(videoRow)
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/',
  requireAuth(),
  validateParams(videoIdParamSchema),
  async (req, res, next) => {
    try {
      const video = await loadAuthorizedVideo(req, res);
      if (!video) {
        return;
      }

      const [rows] = await pool.query(
        `SELECT c.*, u.name AS author_name, u.role AS author_role
         FROM comments c
         JOIN users u ON u.id = c.author_id
         WHERE c.video_id = ?
         ORDER BY c.created_at ASC, c.id ASC`,
        [video.id]
      );

      res.status(200).json({ comments: rows.map(serializeComment) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
