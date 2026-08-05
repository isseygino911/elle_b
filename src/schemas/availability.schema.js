const { z } = require('zod');

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be a valid HH:MM or HH:MM:SS time');

// admin_id is optional and used only by owners, who have no calendar of their
// own and must name the teacher they are acting for (see
// utils/calendarAdmin.js). It must be declared here even though the route
// reads it rather than the handler body: zod strips unknown keys, and
// validateBody reassigns req.body to the parsed result, so an undeclared
// admin_id would be discarded before the resolver ever saw it.
const createAvailabilitySchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    start_time: timeSchema,
    end_time: timeSchema,
    admin_id: z.coerce.number().int().positive().optional()
  })
  .refine((data) => data.end_time > data.start_time, {
    message: 'end_time must be after start_time',
    path: ['end_time']
  });

const availabilityIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid availability id')
});

module.exports = { createAvailabilitySchema, availabilityIdParamSchema };
