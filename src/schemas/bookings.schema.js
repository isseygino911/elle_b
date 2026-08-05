const { z } = require('zod');

const nullableStudentIdSchema = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/, 'must be a numeric id')])
  .transform(Number)
  .nullable()
  .optional();

const createBookingSchema = z.object({
  scheduled_at: z.string().datetime(),
  student_id: nullableStudentIdSchema
});

const openSlotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  // Whose calendar to show. Only meaningful for an owner, who has no calendar
  // of their own -- a student's and a teacher's are derived from their own
  // identity and this parameter is ignored for them. Validated in the route
  // against "is an admin in the caller's organization"; it is never trusted
  // as given.
  admin_id: z.coerce.number().int().positive().optional()
});

const listBookingsQuerySchema = z.object({
  status: z.enum(['booked', 'completed', 'cancelled']).optional(),
  upcoming: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
});

const bookingIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid booking id')
});

const cancelBookingSchema = z.object({
  status: z.literal('cancelled')
});

module.exports = {
  createBookingSchema,
  openSlotsQuerySchema,
  listBookingsQuerySchema,
  bookingIdParamSchema,
  cancelBookingSchema
};
