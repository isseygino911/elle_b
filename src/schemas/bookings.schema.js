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
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
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
