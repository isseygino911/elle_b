const { z } = require('zod');

const notificationIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid notification id')
});

const listNotificationsQuerySchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
});

module.exports = { notificationIdParamSchema, listNotificationsQuerySchema };
