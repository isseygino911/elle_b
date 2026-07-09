const { z } = require('zod');

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be a valid HH:MM or HH:MM:SS time');

const createAvailabilitySchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    start_time: timeSchema,
    end_time: timeSchema
  })
  .refine((data) => data.end_time > data.start_time, {
    message: 'end_time must be after start_time',
    path: ['end_time']
  });

const availabilityIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid availability id')
});

module.exports = { createAvailabilitySchema, availabilityIdParamSchema };
