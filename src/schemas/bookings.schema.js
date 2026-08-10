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

// Max days in one range request, INCLUSIVE of both endpoints. 31 is the
// longest calendar month, which is exactly the frontend month view this
// endpoint exists to serve -- deliberately not a round number, so the value is
// traceable to the requirement rather than to taste. A cap is required, not
// cosmetic: without one, ?from=2020-01-01&to=2030-01-01 is 3650 loop
// iterations and an unbounded bookings fetch, available to any authenticated
// student. Bump it here (one constant, one test) if the grid ever renders
// adjacent months' leading/trailing days -- 42 for a 6x7 grid.
const MAX_RANGE_DAYS = 31;

const openSlotsRangeQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
    // Same contract as openSlotsQuerySchema.admin_id above -- never trusted as
    // given; validated in the route against "is an admin in the caller's org".
    admin_id: z.coerce.number().int().positive().optional()
  })
  // Date.UTC on the parsed components: a pure CALENDAR difference, with no
  // Eastern conversion and therefore no DST involvement. Measuring this span
  // with easternWallClockToUtc would make a 31-day range across the November
  // transition come to 31 days + 1 hour and fail the cap by rounding.
  .refine(
    ({ from, to }) => {
      const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
      const [toYear, toMonth, toDay] = to.split('-').map(Number);
      const days =
        (Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) /
          86400000 +
        1;
      // days >= 1 rejects a reversed range explicitly. Letting it through
      // would return {} -- indistinguishable from "this teacher has no
      // availability", which is the harder of the two bugs to diagnose.
      return days >= 1 && days <= MAX_RANGE_DAYS;
    },
    {
      message: `to must be on or after from, and the range must span at most ${MAX_RANGE_DAYS} days`,
      path: ['to']
    }
  );

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
  openSlotsRangeQuerySchema,
  MAX_RANGE_DAYS,
  listBookingsQuerySchema,
  bookingIdParamSchema,
  cancelBookingSchema
};
