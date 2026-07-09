const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireRole, requireAuth } = require('../middleware/auth');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  uploadUrlRequestSchema,
  createVideoSchema,
  videoIdParamSchema,
  listVideosQuerySchema,
  updateVideoStatusSchema
} = require('../schemas/videos.schema');
const {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_CONTENT_TYPES,
  S3_KEY_PREFIX,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
  PLAYBACK_URL_EXPIRES_IN_SECONDS
} = require('../constants/video');
const s3 = require('../services/s3');
const { sanitizeFilename } = require('../utils/sanitizeFilename');
const { serializeVideo, loadAuthorizedVideo } = require('./videos.helpers');
const { studentExists } = require('../utils/students');

const router = express.Router();

// Confirms a student_id references a real role='student' user. Returns true
// if valid, otherwise sends a 400 and returns false.
async function assertStudentExists(res, studentId) {
  if (!(await studentExists(studentId))) {
    res.status(400).json({ status: 'error', message: 'student_id does not reference an existing student' });
    return false;
  }

  return true;
}

// Shared by POST /upload-url and POST / (both need identical role/type/
// student_id rules): a student may only act on their own practice videos;
// Elle may create either type, but a practice video must name an existing
// student, and a class video's student_id (if provided) must also name an
// existing student. Sends the appropriate error response and returns null if
// the request fails these rules, otherwise returns the resolved student id
// (which may legitimately be null for an unassigned class video).
async function resolveVideoStudentId(req, res) {
  const { type } = req.body;
  const bodyStudentId = req.body.student_id;

  if (req.user.role === 'student') {
    if (type === 'class') {
      res.status(403).json({ status: 'error', message: 'Students may only upload practice videos' });
      return null;
    }

    if (bodyStudentId !== undefined && bodyStudentId !== req.user.id) {
      res.status(400).json({ status: 'error', message: 'student_id must match your own id' });
      return null;
    }

    return { studentId: req.user.id };
  }

  if (type === 'practice') {
    if (bodyStudentId === undefined || bodyStudentId === null) {
      res.status(400).json({ status: 'error', message: 'student_id is required for practice videos' });
      return null;
    }

    if (!(await assertStudentExists(res, bodyStudentId))) {
      return null;
    }

    return { studentId: bodyStudentId };
  }

  if (bodyStudentId !== undefined && bodyStudentId !== null) {
    if (!(await assertStudentExists(res, bodyStudentId))) {
      return null;
    }

    return { studentId: bodyStudentId };
  }

  return { studentId: null };
}

router.post(
  '/upload-url',
  requireAuth(),
  validateBody(uploadUrlRequestSchema),
  async (req, res, next) => {
    try {
      const resolved = await resolveVideoStudentId(req, res);
      if (!resolved) {
        return;
      }

      if (req.body.content_length !== undefined && req.body.content_length > MAX_FILE_SIZE_BYTES) {
        return res.status(400).json({ status: 'error', message: 'File exceeds maximum allowed size' });
      }

      const s3Key = `${S3_KEY_PREFIX}/${crypto.randomUUID()}/${sanitizeFilename(req.body.original_filename)}`;

      let upload;
      try {
        upload = await s3.createVideoUploadPost(s3Key, req.body.content_type);
      } catch (err) {
        console.error('S3 createVideoUploadPost failed:', err);
        return res.status(502).json({ status: 'error', message: 'Failed to generate upload URL' });
      }

      res.status(200).json({
        upload: { url: upload.url, fields: upload.fields, s3_key: s3Key },
        expires_in: UPLOAD_URL_EXPIRES_IN_SECONDS,
        max_file_size_bytes: MAX_FILE_SIZE_BYTES,
        allowed_content_types: ALLOWED_CONTENT_TYPES
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/',
  requireAuth(),
  validateBody(createVideoSchema),
  async (req, res, next) => {
    try {
      const resolved = await resolveVideoStudentId(req, res);
      if (!resolved) {
        return;
      }

      const { type, title, s3_key: s3Key, duration_sec: durationSec } = req.body;

      let head;
      try {
        head = await s3.headVideoObject(s3Key);
      } catch (err) {
        console.error('S3 headVideoObject failed:', err);
        return res.status(502).json({ status: 'error', message: 'Failed to verify upload' });
      }

      if (!head) {
        return res.status(400).json({ status: 'error', message: 'Upload not found — please retry the upload.' });
      }

      if (!ALLOWED_CONTENT_TYPES.includes(head.contentType) || head.contentLength > MAX_FILE_SIZE_BYTES) {
        return res.status(400).json({ status: 'error', message: 'Uploaded file does not meet the requirements' });
      }

      try {
        const [insertResult] = await pool.query(
          `INSERT INTO videos (type, student_id, title, s3_key, duration_sec, status, uploaded_by)
           VALUES (?, ?, ?, ?, ?, 'pending_review', ?)`,
          [type, resolved.studentId, title, s3Key, durationSec ?? null, req.user.id]
        );

        const [videoRows] = await pool.query('SELECT * FROM videos WHERE id = ?', [insertResult.insertId]);

        res.status(201).json({ video: serializeVideo(videoRows[0]) });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ status: 'error', message: 'This upload has already been recorded.' });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);

router.get('/', requireAuth(), validateQuery(listVideosQuerySchema), async (req, res, next) => {
  try {
    const conditions = [];
    const params = [];

    if (req.user.role === 'student') {
      conditions.push('student_id = ?');
      params.push(req.user.id);
    } else {
      if (req.query.student_id) {
        conditions.push('student_id = ?');
        params.push(req.query.student_id);
      }
      if (req.query.type) {
        conditions.push('type = ?');
        params.push(req.query.type);
      }
      if (req.query.status) {
        conditions.push('status = ?');
        params.push(req.query.status);
      }
    }

    let query = 'SELECT * FROM videos';
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC';

    const [rows] = await pool.query(query, params);

    res.status(200).json({ videos: rows.map(serializeVideo) });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:id',
  requireAuth(),
  validateParams(videoIdParamSchema),
  async (req, res, next) => {
    try {
      const video = await loadAuthorizedVideo(req, res);
      if (!video) {
        return;
      }

      res.status(200).json({ video: serializeVideo(video) });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id/playback-url',
  requireAuth(),
  validateParams(videoIdParamSchema),
  async (req, res, next) => {
    try {
      const video = await loadAuthorizedVideo(req, res);
      if (!video) {
        return;
      }

      let url;
      try {
        url = await s3.getVideoPlaybackUrl(video.s3_key);
      } catch (err) {
        console.error('S3 getVideoPlaybackUrl failed:', err);
        return res.status(502).json({ status: 'error', message: 'Failed to generate playback URL' });
      }

      res.status(200).json({ url, expires_in: PLAYBACK_URL_EXPIRES_IN_SECONDS });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  requireRole('elle'),
  validateParams(videoIdParamSchema),
  validateBody(updateVideoStatusSchema),
  async (req, res, next) => {
    try {
      if (req.body.status === 'reviewed') {
        return res.status(400).json({
          status: 'error',
          message:
            "Videos can only be marked 'reviewed' automatically, by Elle posting a comment on them. This endpoint may only be used to revert a video to 'pending_review'."
        });
      }

      const [result] = await pool.query('UPDATE videos SET status = ? WHERE id = ?', [
        req.body.status,
        req.params.id
      ]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Video not found' });
      }

      const [videoRows] = await pool.query('SELECT * FROM videos WHERE id = ?', [req.params.id]);

      res.status(200).json({ video: serializeVideo(videoRows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:id',
  requireAuth(),
  validateParams(videoIdParamSchema),
  async (req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT * FROM videos WHERE id = ?', [req.params.id]);
      const video = rows[0];

      if (!video) {
        return res.status(404).json({ status: 'error', message: 'Video not found' });
      }

      if (video.uploaded_by !== req.user.id) {
        return res.status(403).json({ status: 'error', message: 'You can only delete videos you uploaded' });
      }

      const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM comments WHERE video_id = ?', [video.id]);

      if (count > 0) {
        return res.status(409).json({
          status: 'error',
          message: 'This video has feedback and can no longer be deleted.'
        });
      }

      try {
        await s3.deleteVideoObject(video.s3_key);
      } catch (err) {
        console.error('S3 deleteVideoObject failed:', err);
      }

      await pool.query('DELETE FROM videos WHERE id = ?', [video.id]);

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
