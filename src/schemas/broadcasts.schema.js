const { z } = require('zod');

// `audience` is validated here as the full enum the COLUMN accepts, not as the
// subset the CALLER may send. Whether a given sender may address teachers is a
// permission question, and answering it needs req.user.role, which a schema
// does not have.
//
// So the split is deliberate: this rejects values the database could never
// store (400, bad input), and the route rejects values this sender is not
// permitted to use (403, forbidden). Folding the second check in here would
// report a permission failure as malformed input.
const createBroadcastSchema = z.object({
  audience: z.enum(['students', 'teachers', 'both']),
  title: z.string().trim().min(1).max(255),
  // Required and non-empty, unlike a notification's nullable body: an
  // announcement with a subject line and nothing under it is not a message
  // anyone can act on. 5000 matches sendMessageSchema -- the same person
  // writing the same kind of prose.
  body: z.string().trim().min(1).max(5000)
});

const listBroadcastsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive integer')
    .transform(Number)
    .refine((value) => value > 0, 'limit must be greater than zero')
    .optional(),
  offset: z
    .string()
    .regex(/^\d+$/, 'offset must be a non-negative integer')
    .transform(Number)
    .optional()
});

module.exports = { createBroadcastSchema, listBroadcastsQuerySchema };
