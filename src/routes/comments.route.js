const express = require('express');
const pool = require('../db/pool');
const { CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { requireAuth } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const { videoIdParamSchema } = require('../schemas/videos.schema');
const { createCommentSchema } = require('../schemas/comments.schema');
const { serializeVideo, loadAuthorizedVideo } = require('./videos.helpers');
const { resolveRecipients } = require('../utils/counterparty');
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
        //
        // affectedRows is the transition signal, and it is why the
        // video_reviewed notification below fires exactly once: the
        // `AND status = 'pending_review'` predicate matches no row on a second
        // comment, so justReviewed is false and the student is not told their
        // work was reviewed twice.
        let justReviewed = false;
        if (CAN_READ_STUDENT_DETAIL.has(req.user.role)) {
          const [reviewResult] = await connection.query(
            "UPDATE videos SET status = 'reviewed' WHERE id = ? AND status = 'pending_review'",
            [video.id]
          );
          justReviewed = reviewResult.affectedRows > 0;
        }

        const [videoRows] = await connection.query('SELECT * FROM videos WHERE id = ?', [video.id]);
        videoRow = videoRows[0];

        const recipients = await resolveRecipients(connection, {
          actor: req.user,
          studentId: videoRow.student_id
        });

        for (const userId of recipients) {
          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId,
            actorId: req.user.id,
            type: 'comment',
            title: 'New comment on your video',
            body: null,
            refId: commentId
          });
        }

        // Two distinct facts, deliberately two rows: somebody left feedback,
        // and the video moved out of the review queue. They are not the same
        // event -- a later comment is feedback without a status change -- and
        // collapsing them would mean the student could never tell "reviewed"
        // from "commented on again".
        //
        // ref_id points at the VIDEO, not the comment: this notification is
        // about the video's state, so that is what it should deep-link to.
        if (justReviewed && videoRow.student_id) {
          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId: videoRow.student_id,
            actorId: req.user.id,
            type: 'video_reviewed',
            title: 'Your video was reviewed',
            body: null,
            refId: video.id
          });
        }

        if (recipients.length === 0) {
          // Legitimate for a class video with no owning student, but silent
          // either way without this (BUG C).
          console.warn(
            `[notifications] comment ${commentId} produced no recipients ` +
              `(actor ${req.user.id}, role ${req.user.role}, video ${video.id})`
          );
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
