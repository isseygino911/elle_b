const { z } = require('zod');

// Same split this codebase states once in broadcasts.schema.js and follows
// everywhere: a SCHEMA validates what the COLUMN can hold (400, malformed
// input); a ROUTE validates what this SENDER may use (403, forbidden).
//
// One rule deliberately sits in the ROUTE rather than here: "at least one
// accepts_* must be true". It is expressible as a zod .refine, but on PATCH the
// three flags may arrive partially -- a teacher turning text off sends only
// accepts_text, and whether that leaves the assignment with nothing enabled
// depends on the two values already in the database. A schema cannot see those.
// Putting half the rule here and half in the route would be worse than putting
// all of it in one place, so it lives entirely in the route. (0032's header
// makes the same argument for why it is not a CHECK constraint.)

// YYYY-MM-DD, matching tasks.schema.js. The column is DATE (0032's header
// argues why), so anything carrying a time-of-day is malformed rather than
// merely over-precise.
const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be a YYYY-MM-DD date')
  .nullable()
  .optional();

// NULL means unlimited, so null must survive validation rather than being
// coerced to 0 -- which would mean "no attempts permitted" and lock every
// student out of an assignment the teacher meant to leave open.
const allowedAttemptsSchema = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/, 'must be a positive integer')])
  .transform(Number)
  .nullable()
  .optional();

// The recording cap, in seconds. Bounded at both ends: 0 would auto-stop the
// recorder before it started, and the upper bound keeps a typo ("3000" for
// "300") from authorizing a 50-minute upload against the 2 GiB ceiling that
// prompted the cap in the first place.
const maxRecordingSecSchema = z
  .union([z.number().int(), z.string().regex(/^\d+$/, 'must be a positive integer')])
  .transform(Number)
  .refine((value) => value >= 10 && value <= 3600, {
    message: 'max_recording_sec must be between 10 and 3600 seconds'
  })
  .optional();

// A URL the student is meant to open. http/https only: the column is rendered
// as a link, and permitting javascript: or data: here would turn a teacher's
// field into a delivery vector on every enrolled student's page.
// The protocol allowlist is the load-bearing half, not the URL parse: `z.url()`
// alone accepts javascript: and data:, both of which parse perfectly well.
const referenceUrlSchema = z
  .url({
    protocol: /^https?$/,
    error: 'reference_url must be an http or https URL'
  })
  .max(2048)
  .nullable()
  .optional();

const createAssignmentSchema = z.object({
  title: z.string().trim().min(1).max(255),
  body: z.string().trim().max(20000).nullable().optional(),
  reference_url: referenceUrlSchema,
  due_date: dueDateSchema,
  allowed_attempts: allowedAttemptsSchema,
  accepts_text: z.boolean().optional(),
  accepts_files: z.boolean().optional(),
  accepts_recording: z.boolean().optional(),
  max_recording_sec: maxRecordingSecSchema
});

// PATCH: every field optional, at least one present.
//
// Without the refine, `PATCH {}` is a well-formed request that updates nothing
// and answers 200, which reads to a client as a successful save.
//
// `status` is here rather than on a separate /publish endpoint because publish
// is a state transition on the assignment, not a different resource -- and the
// route's FOR UPDATE read makes the transition idempotent either way.
const updateAssignmentSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    body: z.string().trim().max(20000).nullable().optional(),
    reference_url: referenceUrlSchema,
    due_date: dueDateSchema,
    allowed_attempts: allowedAttemptsSchema,
    accepts_text: z.boolean().optional(),
    accepts_files: z.boolean().optional(),
    accepts_recording: z.boolean().optional(),
    max_recording_sec: maxRecordingSecSchema,
    // Both directions. Retracting a published assignment is an ordinary
    // correction -- homework posted to the wrong course, or published before it
    // was finished -- and the route makes it clean: the notifications are
    // deleted with it, so it leaves no trace on a student's list.
    //
    // The one case the route refuses is retracting an assignment students have
    // already SUBMITTED to, which would orphan real work. That check needs the
    // submissions table, so it lives in the route, not here.
    status: z.enum(['draft', 'published']).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided'
  });

const courseIdParamSchema = z.object({
  courseId: z.string().regex(/^\d+$/, 'Invalid course id')
});

// The nested routes mount under /courses/:courseId/assignments, so both params
// are present and both must be validated -- a route that trusted :courseId
// while checking :id would accept a mismatched pair.
const assignmentInCourseParamSchema = z.object({
  courseId: z.string().regex(/^\d+$/, 'Invalid course id'),
  id: z.string().regex(/^\d+$/, 'Invalid assignment id')
});

const assignmentIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid assignment id')
});

const listAssignmentsQuerySchema = z.object({
  status: z.enum(['draft', 'published']).optional()
});

module.exports = {
  createAssignmentSchema,
  updateAssignmentSchema,
  courseIdParamSchema,
  assignmentInCourseParamSchema,
  assignmentIdParamSchema,
  listAssignmentsQuerySchema
};
