const { z } = require('zod');

const notificationIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid notification id')
});

// limit/offset are strings on the way in (everything in a query string is) and
// are coerced here rather than in the route. The route still clamps limit to
// MAX_LIMIT -- this only rejects values that are not positive integers at all,
// so a caller asking for 10000 gets 100 rather than a 400.
const listNotificationsQuerySchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
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

module.exports = { notificationIdParamSchema, listNotificationsQuerySchema };
