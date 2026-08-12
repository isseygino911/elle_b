// zod schemas for the videos/ route. Unlike multipart metadata,
// these bodies are plain JSON, so student_id/content_length are accepted as
// either a JSON number or a numeric string and normalized to a number.

const { z } = require('zod');
const { ALLOWED_CONTENT_TYPES, S3_KEY_PREFIX } = require('../constants/video');

const S3_KEY_PREFIX_REGEX = new RegExp(`^${S3_KEY_PREFIX}/`);

const VIDEO_TYPES = ['class', 'practice'];
const VIDEO_STATUSES = ['pending_review', 'reviewed'];

const numericIdSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/, 'must be a numeric id')
]).transform(Number);

const nullableStudentIdSchema = numericIdSchema.nullable().optional();

const uploadUrlRequestSchema = z.object({
  type: z.enum(VIDEO_TYPES),
  student_id: nullableStudentIdSchema,
  original_filename: z.string().trim().min(1).max(255),
  content_type: z.enum(ALLOWED_CONTENT_TYPES),
  content_length: z.number().int().nonnegative().optional()
});

const createVideoSchema = z.object({
  type: z.enum(VIDEO_TYPES),
  student_id: nullableStudentIdSchema,
  title: z.string().trim().min(1).max(255),
  s3_key: z.string().regex(S3_KEY_PREFIX_REGEX, `s3_key must start with ${S3_KEY_PREFIX}/`),
  duration_sec: z.number().int().nonnegative().nullable().optional()
});

const videoIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid video id')
});

const listVideosQuerySchema = z.object({
  student_id: z
    .string()
    .regex(/^\d+$/, 'student_id must be a numeric id')
    .optional(),
  type: z.enum(VIDEO_TYPES).optional(),
  status: z.enum(VIDEO_STATUSES).optional()
});

const updateVideoStatusSchema = z.object({
  status: z.enum(VIDEO_STATUSES)
});

module.exports = {
  uploadUrlRequestSchema,
  createVideoSchema,
  videoIdParamSchema,
  listVideosQuerySchema,
  updateVideoStatusSchema
};
