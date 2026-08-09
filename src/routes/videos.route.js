const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireCapability } = require('../middleware/auth');
const { CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { scopeFor } = require('../utils/scope');
const { ROLES } = require('../constants/roles');
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
const { assertStudentInScope } = require('../utils/students');
const { resolveRecipients } = require('../utils/counterparty');
const { insertNotification } = require('./notifications.helpers');

const router = express.Router();

// Confirms a student_id references a student the CALLER MAY ACT ON -- same
// organization, and for a teacher, their own roster. Returns true if valid,
// otherwise sends a 400 and returns false.
async function assertStudentExists(req, res, studentId) {
  const student = await assertStudentInScope(req.user, studentId);

  if (!student) {
    res.status(400).json({ status: 'error', message: 'student_id does not reference an existing student' });
    return null;
  }

  return student;
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

  if (req.user.role === ROLES.STUDENT) {
    if (type === 'class') {
      res.status(403).json({ status: 'error', message: 'Students may only upload practice videos' });
      return null;
    }

    if (bodyStudentId !== undefined && bodyStudentId !== req.user.id) {
      res.status(400).json({ status: 'error', message: 'student_id must match your own id' });
      return null;
    }

    return { studentId: req.user.id, adminId: req.user.adminId };
  }

  if (type === 'practice') {
    if (bodyStudentId === undefined || bodyStudentId === null) {
      res.status(400).json({ status: 'error', message: 'student_id is required for practice videos' });
      return null;
    }

    const student = await assertStudentExists(req, res, bodyStudentId);
    if (!student) {
      return null;
    }

    return { studentId: bodyStudentId, adminId: student.admin_id };
  }

  if (bodyStudentId !== undefined && bodyStudentId !== null) {
    const student = await assertStudentExists(req, res, bodyStudentId);
    if (!student) {
      return null;
    }

    return { studentId: bodyStudentId, adminId: student.admin_id };
  }

  // Class video with no student: the uploading teacher owns it.
  return { studentId: null, adminId: req.user.role === ROLES.ADMIN ? req.user.id : null };
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

      // Transactional as of Phase 2. This INSERT previously stood alone on the
      // pool; now that recording a video also notifies the teacher, the row and
      // its notification must commit together -- otherwise a failed notify
      // leaves a video nobody is told about, which is precisely the bug this
      // phase exists to close.
      const connection = await pool.getConnection();
      let videoId;

      try {
        await connection.beginTransaction();

        try {
          const [insertResult] = await connection.query(
            `INSERT INTO videos (org_id, admin_id, type, student_id, title, s3_key, duration_sec, status, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)`,
            [
              req.user.orgId,
              // The owning teacher: for a student uploader it is their own
              // admin; for a teacher it is themselves. May be null for an
              // org-level class video with no student (videos.admin_id is
              // nullable by design -- see migration 0023).
              resolved.adminId ?? null,
              type, resolved.studentId, title, s3Key, durationSec ?? null, req.user.id
            ]
          );
          videoId = insertResult.insertId;
        } catch (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            // Rolled back here rather than falling through to the outer
            // handler: a duplicate s3_key is a legitimate client retry, not a
            // server fault, and it must still release the transaction.
            await connection.rollback();
            return res.status(409).json({ status: 'error', message: 'This upload has already been recorded.' });
          }
          throw err;
        }

        // A practice video belongs to a student, and the person who needs to
        // know it arrived is their teacher. resolveRecipients is the right
        // helper here (unlike tasks): a video genuinely is a two-party
        // student/teacher artefact, and when an owner uploads on a student's
        // behalf the student's own teacher should hear about it too.
        //
        // studentId is null for a class video with no owning student, in which
        // case there is nobody to notify and the upload simply succeeds.
        const recipients = resolved.studentId
          ? await resolveRecipients(connection, {
              actor: req.user,
              studentId: resolved.studentId
            })
          : [];

        for (const userId of recipients) {
          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId,
            actorId: req.user.id,
            type: 'video_uploaded',
            title: `New video: ${title}`,
            body: null,
            refId: videoId
          });
        }

        if (recipients.length === 0) {
          // Legitimate for an unassigned student or a class video with no
          // student, but silent either way without this (BUG C's pattern).
          console.warn(
            `[notifications] video ${videoId} produced no recipients ` +
              `(actor ${req.user.id}, role ${req.user.role}, student ${resolved.studentId})`
          );
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      const [videoRows] = await pool.query(
        'SELECT * FROM videos WHERE id = ? AND org_id = ?',
        [videoId, req.user.orgId]
      );

      res.status(201).json({ video: serializeVideo(videoRows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/', requireAuth(), validateQuery(listVideosQuerySchema), async (req, res, next) => {
  try {
    // Tenancy first: a student sees only their own videos, an admin only
    // those of their own students, an owner everything in their org. A
    // manager is rejected outright -- a practice video is per-student detail.
    const scope = scopeFor(req.user, {
      org: 'org_id',
      admin: 'admin_id',
      student: 'student_id'
    });

    const conditions = [scope.sql];
    const params = [...scope.params];

    // Filters now apply for EVERY role, not just non-students. Previously they
    // sat in an `else` branch, so a student passing ?type=class was silently
    // ignored. There is no widening risk: the scope predicate above already
    // pins student_id for a student caller, so an additional student_id filter
    // can only narrow the result set, never expand it.
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
  requireCapability(CAN_READ_STUDENT_DETAIL),
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

      // Scoped like PATCH /bookings/:id: the tenancy predicate rides on the
      // UPDATE itself, so affectedRows === 0 covers both "no such video" and
      // "not yours" without a separate lookup -- and without distinguishing
      // them to the caller.
      const scope = scopeFor(req.user, {
        org: 'org_id',
        admin: 'admin_id',
        student: 'student_id'
      });

      const [result] = await pool.query(
        `UPDATE videos SET status = ? WHERE id = ? AND ${scope.sql}`,
        [req.body.status, req.params.id, ...scope.params]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Video not found' });
      }

      const [videoRows] = await pool.query(
        `SELECT * FROM videos WHERE id = ? AND ${scope.sql}`,
        [req.params.id, ...scope.params]
      );

      res.status(200).json({ video: serializeVideo(videoRows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

// requireAuth() and not requireCapability, deliberately: the uploaded_by check
// below is STRICTER than either capability set -- you may only delete what you
// uploaded yourself -- and a student deleting their own practice video is a
// legitimate flow that requireCapability({owner, admin}) would break.
router.delete(
  '/:id',
  requireAuth(),
  validateParams(videoIdParamSchema),
  async (req, res, next) => {
    try {
      const video = await loadAuthorizedVideo(req, res);
      if (!video) {
        return;
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

      await pool.query('DELETE FROM videos WHERE id = ? AND org_id = ?', [
        video.id,
        req.user.orgId
      ]);

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
