const { z } = require('zod');

const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  timestamp_sec: z.number().int().nonnegative().nullable().optional()
});

module.exports = { createCommentSchema };
