const { z } = require('zod');
const { ALLOWED_CONTENT_TYPES, S3_KEY_PREFIX } = require('../constants/submissions');

// Same split this codebase states once in broadcasts.schema.js and follows
// everywhere: a SCHEMA validates what the COLUMN can hold (400, malformed
// input); a ROUTE validates what this SENDER may use (403, forbidden).
//
// Almost every interesting rule about a submission sits in the ROUTE rather
// than here, and for one reason: they all depend on the parent ASSIGNMENT,
// which a schema cannot see. Whether text is permitted, whether a recording is
// permitted, how long a recording may run, how many attempts remain -- each is
// a column on assignments, read at request time. What is left here is the
// shape of the request itself.
//
// The one rule that looks like it belongs in the route but lives here is
// "a file entry must name a kind, a filename, and a key". That is a statement
// about the request body's structure, true regardless of which assignment it
// targets.

const S3_KEY_PREFIX_REGEX = new RegExp(`^${S3_KEY_PREFIX}/`);

// One uploaded object the student is claiming as part of this submission.
//
// `kind` is required rather than defaulting to 'attachment'. The column has a
// default, but a client that omits it here is almost certainly a recording
// path that forgot to label itself -- and a recording silently filed as an
// attachment skips the video/webm and duration checks entirely. Making the
// field explicit turns that bug into a 400.
const submissionFileSchema = z.object({
  kind: z.enum(['attachment', 'recording']),
  original_filename: z.string().trim().min(1).max(255),
  s3_key: z.string().regex(S3_KEY_PREFIX_REGEX, `s3_key must start with ${S3_KEY_PREFIX}/`),
  // NULL is a legitimate value, not a missing one.
  //
  // A MediaRecorder WebM carries no duration in its header, so useMediaRecorder
  // counts wall-clock seconds and returns `secondsRef.current || null` -- which
  // is null, not 0, for a sub-second take. Coercing that to 0 would record a
  // measurement nobody made; rejecting it would refuse a legitimate short
  // recording. See 0033's note on the column.
  duration_sec: z.number().int().nonnegative().nullable().optional()
});

const createSubmissionSchema = z.object({
  // Trimmed, so a body of spaces is indistinguishable from no body at all --
  // which matters because the route's "empty in every part" check tests this
  // field for emptiness. Without the trim, "   " would count as text and let a
  // student submit nothing while appearing to submit something.
  body: z.string().trim().max(20000).nullable().optional(),
  // Absent and [] mean the same thing and both are valid: a text-only
  // submission carries no files.
  files: z.array(submissionFileSchema).max(20).optional()
});

// A student editing their own work before it is reviewed.
//
// Only `body`. Files are not editable here: each one is an S3 object confirmed
// at submit time, and "editing" the list would mean orphaning objects or
// admitting unverified keys through a path that does no HeadObject. A student
// who wants different files submits another attempt, which is the mechanism
// this feature already has for exactly that.
const updateSubmissionSchema = z.object({
  body: z.string().trim().max(20000).nullable()
});

// The teacher's response. `feedback` is required and non-empty: marking work
// reviewed is a promise to the student that someone looked at it, and an empty
// review is the one outcome that promise cannot survive.
const reviewSubmissionSchema = z.object({
  feedback: z.string().trim().min(1).max(20000)
});

const uploadUrlRequestSchema = z.object({
  original_filename: z.string().trim().min(1).max(255),
  content_type: z.enum(ALLOWED_CONTENT_TYPES),
  content_length: z.number().int().nonnegative().optional()
});

const assignmentIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid assignment id')
});

const submissionIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid submission id')
});

const submissionFileParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid submission id'),
  fileId: z.string().regex(/^\d+$/, 'Invalid file id')
});

// A teacher narrowing the review queue. Absent means every attempt.
const listSubmissionsQuerySchema = z.object({
  status: z.enum(['submitted', 'reviewed']).optional(),
  student_id: z.string().regex(/^\d+$/, 'Invalid student id').optional()
});

module.exports = {
  createSubmissionSchema,
  updateSubmissionSchema,
  reviewSubmissionSchema,
  uploadUrlRequestSchema,
  assignmentIdParamSchema,
  submissionIdParamSchema,
  submissionFileParamSchema,
  listSubmissionsQuerySchema
};
