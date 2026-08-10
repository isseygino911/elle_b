const { z } = require('zod');

// Same TIME shape as availability.schema.js's timeSchema. Deliberately NOT
// imported from there: that module's export is scoped to the recurring
// template, and cross-importing a leaf validator between two sibling schema
// files would couple them for three lines of regex. If a third schema needs
// it, promote it to a shared module then -- not before.
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be a valid HH:MM or HH:MM:SS time');

// An America/New_York calendar date -- the same thing computeOpenSlots's
// `date` parameter has always meant. Regex-only, matching
// openSlotsQuerySchema's existing `date`, rather than z.coerce.date(): the
// latter would parse "2026-08-10" as UTC midnight and hand the route a Date
// that the DB layer would then re-serialize through a local-timezone
// conversion. The string goes to MySQL untouched.
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

// "09:00" and "09:00:00" are the same instant but compare as different
// strings -- and crucially "09:00" > "09:00:00" is FALSE, so a naive
// comparison would admit end_time === start_time. Normalizing both to
// HH:MM:SS before comparing removes that.
//
// (createAvailabilitySchema compares the raw strings and has this same latent
// hole. Pre-existing and out of scope here -- but don't copy it.)
function padTime(value) {
  return value.length === 5 ? `${value}:00` : value;
}

// admin_id must be declared here even though the handler does not destructure
// it: zod strips unknown keys and validateBody REASSIGNS req.body to the
// parsed result, so an undeclared admin_id is gone before
// resolveCalendarAdminId can read it -- and every owner write would then 400
// with "admin_id is required" no matter what the client sent. Same trap
// availability.schema.js:7-12 documents.
const createAvailabilityExceptionSchema = z
  .object({
    date: dateSchema,
    type: z.enum(['block', 'add']),
    // Omitted or null both mean "whole day", which is only valid on a 'block'.
    // .nullish() so a client can round-trip a GET response (where these are
    // JSON null) straight back into a PATCH without stripping the nulls first.
    start_time: timeSchema.nullish(),
    end_time: timeSchema.nullish(),
    admin_id: z.coerce.number().int().positive().optional()
  })
  // Mirrors chk_availability_exceptions_times_paired. Checked here as well as
  // in SQL so the teacher gets a message naming the field rather than a
  // generic constraint violation.
  .refine((data) => (data.start_time == null) === (data.end_time == null), {
    message:
      'start_time and end_time must both be provided, or both omitted for a whole-day block',
    path: ['end_time']
  })
  // Mirrors chk_availability_exceptions_time_order.
  //
  // Guards on BOTH values, not just start_time: zod v4 runs every .refine() on
  // the object even after an earlier one has already failed, so on an unpaired
  // { start_time } input this check still executes -- and padTime(undefined)
  // would throw a TypeError that escapes validation entirely and surfaces as a
  // 500 instead of the 400 the pairing refine above already decided on.
  .refine(
    (data) =>
      data.start_time == null ||
      data.end_time == null ||
      padTime(data.end_time) > padTime(data.start_time),
    { message: 'end_time must be after start_time', path: ['end_time'] }
  )
  // Mirrors chk_availability_exceptions_add_has_times. A whole-day 'add' has
  // no defensible meaning and would generate 48 candidate slots from one row.
  .refine((data) => data.type !== 'add' || data.start_time != null, {
    message: "an 'add' exception must specify start_time and end_time",
    path: ['start_time']
  });

const listAvailabilityExceptionsQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  admin_id: z.coerce.number().int().positive().optional()
});

const availabilityExceptionIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid availability exception id')
});

module.exports = {
  createAvailabilityExceptionSchema,
  listAvailabilityExceptionsQuerySchema,
  availabilityExceptionIdParamSchema
};
