// zod schemas for the library/ route. Bodies are plain JSON (the file
// itself goes straight to S3 via a presigned POST, never through Express),
// so ids are accepted as either a JSON number or a numeric string and
// normalized to a number — same convention as videos.schema.js.

const { z } = require('zod');
const { ALLOWED_CONTENT_TYPES, S3_KEY_PREFIX } = require('../constants/library');

const S3_KEY_PREFIX_REGEX = new RegExp(`^${S3_KEY_PREFIX}/`);

const numericIdSchema = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/, 'must be a numeric id')])
  .transform(Number);

// A file may be deliberately filed nowhere ("Uncategorized"), so an explicit
// null is meaningful here and distinct from omitting the field.
const nullableCategoryIdSchema = numericIdSchema.nullable().optional();

const uploadUrlRequestSchema = z.object({
  original_filename: z.string().trim().min(1).max(255),
  content_type: z.enum(ALLOWED_CONTENT_TYPES),
  content_length: z.number().int().nonnegative().optional()
});

const createFileSchema = z.object({
  category_id: nullableCategoryIdSchema,
  title: z.string().trim().min(1).max(255),
  original_filename: z.string().trim().min(1).max(255),
  s3_key: z.string().regex(S3_KEY_PREFIX_REGEX, `s3_key must start with ${S3_KEY_PREFIX}/`),
  description: z.string().trim().max(2000).nullable().optional()
});

// The move-between-categories / rename endpoint. Every field is optional so
// the same route serves both a pure move and a metadata edit, but at least
// one must be present — otherwise the request is a no-op and almost
// certainly a client bug worth surfacing as a 400.
const updateFileSchema = z
  .object({
    category_id: nullableCategoryIdSchema,
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2000).nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update'
  });

const fileIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid file id')
});

// 'uncategorized' is a distinct filter from omitting category_id entirely:
// omitting means "every file", the sentinel means "only files filed nowhere".
// A numeric string can't express that, hence the literal.
const listFilesQuerySchema = z.object({
  category_id: z
    .union([z.literal('uncategorized'), z.string().regex(/^\d+$/, 'category_id must be a numeric id')])
    .optional(),
  q: z.string().trim().min(1).max(255).optional()
});

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(255)
});

const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(255)
});

const categoryIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid category id')
});

module.exports = {
  uploadUrlRequestSchema,
  createFileSchema,
  updateFileSchema,
  fileIdParamSchema,
  listFilesQuerySchema,
  createCategorySchema,
  updateCategorySchema,
  categoryIdParamSchema
};
