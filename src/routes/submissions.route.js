const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { ROLES, CAN_MANAGE_COURSES, CAN_SUBMIT_WORK } = require('../constants/roles');
const { requireAuth, requireCapability } = require('../middleware/auth');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  MAX_FILE_SIZE_BYTES,
  ALLOWED_CONTENT_TYPES,
  RECORDING_CONTENT_TYPE,
  S3_KEY_PREFIX,
  UPLOAD_URL_EXPIRES_IN_SECONDS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS
} = require('../constants/submissions');
const s3 = require('../services/s3');
const { sanitizeFilename } = require('../utils/sanitizeFilename');
const { insertNotification } = require('./notifications.helpers');
const {
  serializeSubmission,
  loadAssignmentInScope,
  fetchFilesBySubmission
} = require('./submissions.helpers');
const {
  createSubmissionSchema,
  updateSubmissionSchema,
  reviewSubmissionSchema,
  uploadUrlRequestSchema,
  assignmentIdParamSchema,
  submissionIdParamSchema,
  submissionFileParamSchema,
  listSubmissionsQuerySchema
} = require('../schemas/submissions.schema');

const router = express.Router();

// A manager must never reach a submission: it is a named student's own work,
// which is their one hard exclusion (see the header of constants/roles.js).
// They are absent from CAN_MANAGE_COURSES and CAN_SUBMIT_WORK for that reason,
// so every mutating endpoint here already turns them away.
//
// The two GET endpoints cannot use requireCapability, because a student must
// reach them and a student is (correctly) absent from both sets. So the manager
// is refused explicitly, mirroring assignments.route.js.
//
// Without this they would still be denied: both scope loaders end in a
// fail-closed branch for an unrecognized role and answer 404. Verified by
// mutation -- stubbing this function to `return false` leaves the manager
// locked out, it just changes the status.
//
// It is kept because that denial is incidental rather than intentional. A 404
// says "no such submission" where the truth is "not for you", and the inner
// layer only holds while every endpoint here happens to route through a scope
// loader. Stating the rule where the rule belongs means a future endpoint --
// a COUNT, an aggregate, anything phrased so the loader is never reached --
// inherits the boundary instead of silently omitting it.
function managerRefused(user) {
  return !CAN_MANAGE_COURSES.has(user.role) && !CAN_SUBMIT_WORK.has(user.role);
}

// Resolves the assignment, or writes the response and returns null.
//
// The whole authorization boundary for this file. See loadAssignmentInScope --
// it composes the course rule rather than restating it, so there is no
// submission-specific rule that could drift from the course one.
async function requireAssignment(req, res, assignmentId, executor = pool) {
  if (managerRefused(req.user)) {
    res.status(403).json({ status: 'error', message: 'Forbidden' });
    return null;
  }

  const assignment = await loadAssignmentInScope(req.user, assignmentId, executor);

  if (!assignment) {
    res.status(404).json({ status: 'error', message: 'Assignment not found' });
    return null;
  }

  return assignment;
}

// Loads a submission the caller may see, or null. Fenced by the same rule as
// the assignment it belongs to, plus one extra clause for students.
//
// The student clause is the boundary the plan names as must-not-regress: a
// student reaches only their OWN submission, enforced here rather than by a
// filter the caller supplies. It is a separate predicate from the assignment
// scope because a student enrolled in a course can legitimately see the
// assignment while having no business seeing a classmate's work against it.
async function loadSubmissionInScope(user, submissionId, executor = pool) {
  const [rows] = await executor.query(
    `SELECT s.*, u.name AS student_name, a.title AS assignment_title,
            a.course_id, a.status AS assignment_status, c.admin_id AS course_admin_id
       FROM submissions s
       JOIN users u ON u.id = s.student_id
       JOIN assignments a ON a.id = s.assignment_id
       JOIN courses c ON c.id = a.course_id
      WHERE s.id = ? AND s.org_id = ?`,
    [submissionId, user.orgId]
  );

  const submission = rows[0];

  if (!submission) {
    return null;
  }

  if (user.role === ROLES.STUDENT) {
    // eslint-disable-next-line eqeqeq
    return submission.student_id == user.id ? submission : null;
  }

  if (user.role === ROLES.ADMIN) {
    // eslint-disable-next-line eqeqeq
    return submission.course_admin_id == user.id ? submission : null;
  }

  if (user.role === ROLES.OWNER) {
    return submission;
  }

  // Fail closed, matching scopeFor's default branch.
  return null;
}

// --- Upload ---------------------------------------------------------------

// POST /assignments/:id/submissions/upload-url
//
// Students only. A teacher has no upload path here because a teacher does not
// submit work -- CAN_SUBMIT_WORK's own header argues why, and minting them a
// key under submissions/ would produce an object no submission could ever
// reference.
router.post(
  '/assignments/:id/submissions/upload-url',
  requireCapability(CAN_SUBMIT_WORK),
  validateParams(assignmentIdParamSchema),
  validateBody(uploadUrlRequestSchema),
  async (req, res, next) => {
    try {
      // Scope-checked BEFORE a key is minted. Skipping this would let any
      // student request an upload slot against any assignment id -- the object
      // would be orphaned rather than readable, but it would still be storage
      // written on an unauthorized request.
      const assignment = await requireAssignment(req, res, req.params.id);
      if (!assignment) {
        return;
      }

      if (req.body.content_length !== undefined && req.body.content_length > MAX_FILE_SIZE_BYTES) {
        return res
          .status(400)
          .json({ status: 'error', message: 'File exceeds maximum allowed size' });
      }

      const s3Key = `${S3_KEY_PREFIX}/${crypto.randomUUID()}/${sanitizeFilename(req.body.original_filename)}`;

      let upload;
      try {
        upload = await s3.createSubmissionUploadPost(s3Key, req.body.content_type);
      } catch (err) {
        console.error('S3 createSubmissionUploadPost failed:', err);
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

// --- Submit ---------------------------------------------------------------

// Checks one declared file against what the assignment permits and what S3
// actually holds. Returns an error message, or null when the file is good.
//
// Takes the head result rather than fetching it, so the caller can do all its
// S3 round trips before opening the transaction.
function validateSubmissionFile(file, head, assignment) {
  if (!head) {
    return `Upload not found for ${file.original_filename} — please retry the upload.`;
  }

  if (!ALLOWED_CONTENT_TYPES.includes(head.contentType)) {
    return `${file.original_filename} is not an accepted file type`;
  }

  if (head.contentLength > MAX_FILE_SIZE_BYTES) {
    return `${file.original_filename} exceeds the maximum allowed size`;
  }

  if (file.kind === 'recording') {
    if (!assignment.accepts_recording) {
      return 'This assignment does not accept a recording';
    }

    // The type is re-checked against what S3 holds, not against what the
    // client labelled it. A kind='recording' row is exempted from nothing, but
    // its duration is trusted below -- and trusting a duration on an object
    // that is not actually a recorder take would be trusting an arbitrary
    // number about an arbitrary file.
    if (head.contentType !== RECORDING_CONTENT_TYPE) {
      return `A recording must be ${RECORDING_CONTENT_TYPE}`;
    }

    // null is legitimate and must pass: a sub-second take reports no duration
    // at all (0033's note on the column, and the schema's). Only a number that
    // is present AND over the cap is a failure.
    if (
      file.duration_sec !== null &&
      file.duration_sec !== undefined &&
      file.duration_sec > assignment.max_recording_sec
    ) {
      return `A recording may be at most ${assignment.max_recording_sec} seconds`;
    }

    return null;
  }

  if (!assignment.accepts_files) {
    return 'This assignment does not accept file attachments';
  }

  return null;
}

// POST /assignments/:id/submissions -- the core of the feature.
//
// One transaction covering: the attempt number, the parent row, every file row,
// and the teacher's notification. All of it or none of it -- a submission whose
// files half-landed is worse than a submission that failed outright, because
// the student believes they handed in work they did not.
router.post(
  '/assignments/:id/submissions',
  requireCapability(CAN_SUBMIT_WORK),
  validateParams(assignmentIdParamSchema),
  validateBody(createSubmissionSchema),
  async (req, res, next) => {
    try {
      const assignment = await requireAssignment(req, res, req.params.id);
      if (!assignment) {
        return;
      }

      const files = req.body.files ?? [];
      const body = req.body.body ?? null;
      const hasText = Boolean(body);

      // The three accepts_* checks. Each is a distinct message, because "your
      // submission was rejected" tells a student nothing about which part to
      // remove.
      //
      // Text is checked here; files and recordings are checked per-entry in
      // validateSubmissionFile, since a submission may mix kinds and only one
      // of them may be the problem.
      if (hasText && !assignment.accepts_text) {
        return res
          .status(400)
          .json({ status: 'error', message: 'This assignment does not accept a written answer' });
      }

      // A submission with no part at all. Distinct from any accepts_* failure:
      // nothing was rejected, there was simply nothing to hand in. Without this
      // a student could "submit" an empty row and consume an attempt.
      if (!hasText && files.length === 0) {
        return res.status(400).json({
          status: 'error',
          message: 'A submission must include a written answer, a file, or a recording'
        });
      }

      // Every S3 HeadObject BEFORE the transaction opens.
      //
      // These are network calls to another service. Holding an open transaction
      // -- and, further down, a FOR UPDATE lock on the student's attempt rows --
      // across them would mean an S3 timeout pinning a database row for as long
      // as the AWS SDK's retries take.
      const heads = [];
      for (const file of files) {
        try {
          // eslint-disable-next-line no-await-in-loop
          heads.push(await s3.headSubmissionObject(file.s3_key));
        } catch (err) {
          console.error('S3 headSubmissionObject failed:', err);
          return res.status(502).json({ status: 'error', message: 'Failed to verify upload' });
        }
      }

      for (const [index, file] of files.entries()) {
        const problem = validateSubmissionFile(file, heads[index], assignment);
        if (problem) {
          return res.status(400).json({ status: 'error', message: problem });
        }
      }

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        // The attempt number, computed under a lock.
        //
        // FOR UPDATE on this student's existing attempts for this assignment:
        // two concurrent submits would otherwise both read MAX(attempt) = 1 and
        // both write attempt 2. The UNIQUE key in 0033 is the backstop that
        // makes the second one fail loudly rather than corrupt the sequence;
        // this lock is what stops it happening in the first place.
        const [attemptRows] = await connection.query(
          `SELECT COALESCE(MAX(attempt), 0) AS max_attempt
             FROM submissions
            WHERE assignment_id = ? AND student_id = ? FOR UPDATE`,
          [assignment.id, req.user.id]
        );
        const attempt = Number(attemptRows[0].max_attempt) + 1;

        // NULL allowed_attempts means unlimited (0032's column note), so the
        // null check has to come first -- `attempt > null` is NULL in SQL and
        // false in JS, which would silently mean "unlimited" either way, but
        // only by accident.
        if (assignment.allowed_attempts !== null && attempt > assignment.allowed_attempts) {
          await connection.rollback();
          return res.status(400).json({
            status: 'error',
            message: `This assignment allows at most ${assignment.allowed_attempts} attempt(s)`
          });
        }

        const [result] = await connection.query(
          'INSERT INTO submissions (org_id, assignment_id, student_id, attempt, body) VALUES (?, ?, ?, ?, ?)',
          [req.user.orgId, assignment.id, req.user.id, attempt, body]
        );

        const submissionId = result.insertId;

        for (const [index, file] of files.entries()) {
          const head = heads[index];
          // Size and type come from S3, never from the client. The client
          // declares which object it uploaded; S3 is the authority on what that
          // object turned out to be. Same posture as library.route.js.
          // eslint-disable-next-line no-await-in-loop
          await connection.query(
            `INSERT INTO submission_files
               (org_id, submission_id, kind, original_filename, s3_key, content_type, size_bytes, duration_sec)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              req.user.orgId,
              submissionId,
              file.kind,
              file.original_filename,
              file.s3_key,
              head.contentType,
              head.contentLength,
              file.duration_sec ?? null
            ]
          );
        }

        // The teacher is the COURSE's admin_id, not the student's users.admin_id.
        //
        // Those differ, and the course is the right one: enrollment is what
        // grants a teacher access to this student's work (courses.route.js made
        // that the rule when the roster-identity check was removed), so the
        // teacher who set the homework is the teacher who should be told it
        // arrived -- whether or not the student is otherwise on their roster.
        await insertNotification(connection, {
          orgId: req.user.orgId,
          userId: assignment.course_admin_id,
          actorId: req.user.id,
          type: 'submission_received',
          title: `${req.user.name} submitted ${assignment.title}`,
          body: attempt > 1 ? `Attempt ${attempt}` : null,
          refId: submissionId
        });

        await connection.commit();

        const [rows] = await pool.query(
          `SELECT s.*, u.name AS student_name, a.title AS assignment_title
             FROM submissions s
             JOIN users u ON u.id = s.student_id
             JOIN assignments a ON a.id = s.assignment_id
            WHERE s.id = ?`,
          [submissionId]
        );
        const filesBySubmission = await fetchFilesBySubmission([submissionId]);

        return res.status(201).json({
          submission: serializeSubmission(rows[0], filesBySubmission.get(Number(submissionId)) ?? [])
        });
      } catch (err) {
        await connection.rollback();

        // A replayed confirm: the same s3_key arriving twice. The UNIQUE key in
        // 0033 catches it, and 409 says "already recorded" rather than letting a
        // double-click create a second attempt pointing at one object.
        if (err.code === 'ER_DUP_ENTRY') {
          return res
            .status(409)
            .json({ status: 'error', message: 'This upload has already been recorded.' });
        }

        return next(err);
      } finally {
        connection.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

// --- Read -----------------------------------------------------------------

// GET /assignments/:id/submissions
//
// A teacher sees every attempt by every enrolled student. A STUDENT sees only
// their own -- enforced by the predicate below, not by a filter the caller
// supplies. The plan names this as a must-not-regress boundary and the test
// asserts it against the raw JSON.
router.get(
  '/assignments/:id/submissions',
  requireAuth(),
  validateParams(assignmentIdParamSchema),
  validateQuery(listSubmissionsQuerySchema),
  async (req, res, next) => {
    try {
      const assignment = await requireAssignment(req, res, req.params.id);
      if (!assignment) {
        return;
      }

      const conditions = ['s.assignment_id = ?', 's.org_id = ?'];
      const params = [assignment.id, req.user.orgId];

      if (req.user.role === ROLES.STUDENT) {
        // Not negotiable, and deliberately not driven by req.query.student_id:
        // a student asking for someone else's work gets their own rather than
        // an error, for the same reason a student asking for ?status=draft gets
        // published assignments -- the existence of other students' work is not
        // theirs to probe.
        conditions.push('s.student_id = ?');
        params.push(req.user.id);
      } else if (req.query.student_id) {
        conditions.push('s.student_id = ?');
        params.push(req.query.student_id);
      }

      if (req.query.status) {
        conditions.push('s.status = ?');
        params.push(req.query.status);
      }

      const [rows] = await pool.query(
        `SELECT s.*, u.name AS student_name, a.title AS assignment_title
           FROM submissions s
           JOIN users u ON u.id = s.student_id
           JOIN assignments a ON a.id = s.assignment_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY s.student_id ASC, s.attempt ASC`,
        params
      );

      const filesBySubmission = await fetchFilesBySubmission(rows.map((row) => row.id));

      res.status(200).json({
        submissions: rows.map((row) =>
          serializeSubmission(row, filesBySubmission.get(Number(row.id)) ?? [])
        )
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /submissions/:id -- one attempt, with its files.
router.get(
  '/submissions/:id',
  requireAuth(),
  validateParams(submissionIdParamSchema),
  async (req, res, next) => {
    try {
      // requireAuth rather than requireCapability, because a student reads
      // their own work here. So the manager is refused explicitly -- see
      // managerRefused above.
      if (managerRefused(req.user)) {
        return res.status(403).json({ status: 'error', message: 'Forbidden' });
      }

      const submission = await loadSubmissionInScope(req.user, req.params.id);

      // 404 rather than 403 for "not yours", consistent with every other read
      // here: a distinguishable error would let a caller enumerate ids.
      if (!submission) {
        return res.status(404).json({ status: 'error', message: 'Submission not found' });
      }

      const filesBySubmission = await fetchFilesBySubmission([submission.id]);

      res.status(200).json({
        submission: serializeSubmission(
          submission,
          filesBySubmission.get(Number(submission.id)) ?? []
        )
      });
    } catch (err) {
      next(err);
    }
  }
);

// Both signed-URL endpoints differ only in Content-Disposition, so they share
// one handler factory -- the library.route.js precedent. 'download' forces a
// save; 'preview' lets a <video> element play a recording in place.
function signedUrlHandler(mode) {
  const sign = mode === 'preview' ? s3.getSubmissionPreviewUrl : s3.getSubmissionDownloadUrl;

  return async (req, res, next) => {
    try {
      if (managerRefused(req.user)) {
        return res.status(403).json({ status: 'error', message: 'Forbidden' });
      }

      // The submission is scope-checked before the S3 object is touched. An
      // unfenced load here would mint a working signed URL for another
      // student's recording -- the one failure in this file that would hand
      // over the actual media rather than a row.
      const submission = await loadSubmissionInScope(req.user, req.params.id);

      if (!submission) {
        return res.status(404).json({ status: 'error', message: 'Submission not found' });
      }

      const [rows] = await pool.query(
        'SELECT * FROM submission_files WHERE id = ? AND submission_id = ? AND org_id = ?',
        [req.params.fileId, submission.id, req.user.orgId]
      );
      const file = rows[0];

      if (!file) {
        return res.status(404).json({ status: 'error', message: 'File not found' });
      }

      let url;
      try {
        url = await sign(file.s3_key, file.original_filename);
      } catch (err) {
        console.error(`S3 submission ${mode} URL failed:`, err);
        return res
          .status(502)
          .json({ status: 'error', message: `Failed to generate ${mode} URL` });
      }

      res.status(200).json({
        url,
        expires_in: DOWNLOAD_URL_EXPIRES_IN_SECONDS,
        content_type: file.content_type
      });
    } catch (err) {
      next(err);
    }
  };
}

router.get(
  '/submissions/:id/files/:fileId/download-url',
  requireAuth(),
  validateParams(submissionFileParamSchema),
  signedUrlHandler('download')
);

router.get(
  '/submissions/:id/files/:fileId/preview-url',
  requireAuth(),
  validateParams(submissionFileParamSchema),
  signedUrlHandler('preview')
);

// --- Edit and review ------------------------------------------------------

// PATCH /submissions/:id -- the student edits their own written answer.
//
// THE LOCK. A student may revise freely until the teacher reviews, and never
// after. Without it, feedback ends up attached to work that has since changed
// underneath it -- the comment says "watch bar 14" and bar 14 is now different.
//
// Enforced here, server-side, rather than by hiding the form: the UI hiding it
// is a courtesy, this is the boundary.
router.patch(
  '/submissions/:id',
  requireCapability(CAN_SUBMIT_WORK),
  validateParams(submissionIdParamSchema),
  validateBody(updateSubmissionSchema),
  async (req, res, next) => {
    try {
      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        const submission = await loadSubmissionInScope(req.user, req.params.id, connection);

        if (!submission) {
          await connection.rollback();
          return res.status(404).json({ status: 'error', message: 'Submission not found' });
        }

        // Re-read under a lock. Between the scope load and the update, the
        // teacher could review this row; without the lock the edit would land
        // on already-reviewed work, which is the exact thing this endpoint
        // exists to prevent. The tasks.route.js FOR UPDATE idiom.
        const [lockedRows] = await connection.query(
          'SELECT status FROM submissions WHERE id = ? AND org_id = ? FOR UPDATE',
          [submission.id, req.user.orgId]
        );

        if (lockedRows[0].status === 'reviewed') {
          await connection.rollback();
          return res.status(409).json({
            status: 'error',
            message:
              'This submission has been reviewed and can no longer be edited. Submit a new attempt instead.'
          });
        }

        // The assignment must still accept text. A teacher who turned
        // accepts_text off after this was submitted has said the written part
        // is no longer wanted, and letting an edit re-add it would route around
        // that.
        if (req.body.body && !submission.accepts_text) {
          const [assignmentRows] = await connection.query(
            'SELECT accepts_text FROM assignments WHERE id = ?',
            [submission.assignment_id]
          );

          if (!assignmentRows[0].accepts_text) {
            await connection.rollback();
            return res
              .status(400)
              .json({ status: 'error', message: 'This assignment does not accept a written answer' });
          }
        }

        // A submission cannot be edited down to nothing. If it carries no
        // files, the body is the only part it has, and blanking it would leave
        // an attempt that says nothing while still counting against the limit.
        if (!req.body.body) {
          const [fileCountRows] = await connection.query(
            'SELECT COUNT(*) AS count FROM submission_files WHERE submission_id = ?',
            [submission.id]
          );

          if (Number(fileCountRows[0].count) === 0) {
            await connection.rollback();
            return res.status(400).json({
              status: 'error',
              message: 'A submission must include a written answer, a file, or a recording'
            });
          }
        }

        await connection.query('UPDATE submissions SET body = ? WHERE id = ? AND org_id = ?', [
          req.body.body,
          submission.id,
          req.user.orgId
        ]);

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      const submission = await loadSubmissionInScope(req.user, req.params.id);
      const filesBySubmission = await fetchFilesBySubmission([submission.id]);

      res.status(200).json({
        submission: serializeSubmission(
          submission,
          filesBySubmission.get(Number(submission.id)) ?? []
        )
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /submissions/:id/review -- the teacher responds.
//
// Sets feedback, flips status, and notifies the student, all in one
// transaction: feedback the student is never told about is feedback that did
// not happen.
router.patch(
  '/submissions/:id/review',
  requireCapability(CAN_MANAGE_COURSES),
  validateParams(submissionIdParamSchema),
  validateBody(reviewSubmissionSchema),
  async (req, res, next) => {
    try {
      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        const submission = await loadSubmissionInScope(req.user, req.params.id, connection);

        if (!submission) {
          await connection.rollback();
          return res.status(404).json({ status: 'error', message: 'Submission not found' });
        }

        // Read-before-update under a lock, so re-reviewing is idempotent in the
        // one way that matters: the student is notified once. A teacher
        // correcting a typo in their feedback must not send a second "your work
        // was reviewed" -- the same reasoning as the publish fan-out in
        // assignments.route.js.
        const [lockedRows] = await connection.query(
          'SELECT status FROM submissions WHERE id = ? AND org_id = ? FOR UPDATE',
          [submission.id, req.user.orgId]
        );

        const wasAlreadyReviewed = lockedRows[0].status === 'reviewed';

        await connection.query(
          `UPDATE submissions
              SET feedback = ?, status = 'reviewed', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP()
            WHERE id = ? AND org_id = ?`,
          [req.body.feedback, req.user.id, submission.id, req.user.orgId]
        );

        if (!wasAlreadyReviewed) {
          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId: submission.student_id,
            actorId: req.user.id,
            type: 'submission_reviewed',
            title: `Feedback on ${submission.assignment_title}`,
            body: null,
            refId: submission.id
          });
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      const submission = await loadSubmissionInScope(req.user, req.params.id);
      const filesBySubmission = await fetchFilesBySubmission([submission.id]);

      res.status(200).json({
        submission: serializeSubmission(
          submission,
          filesBySubmission.get(Number(submission.id)) ?? []
        )
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
