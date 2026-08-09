const { z } = require('zod');

// The split this file observes, stated once in broadcasts.schema.js and
// followed everywhere since: a SCHEMA validates what the COLUMN can hold (400,
// malformed input); a ROUTE validates what this SENDER may use (403,
// forbidden). Neither one may do the other's job -- folding a permission check
// in here would report "not yours" as "badly formed", and moving a length check
// into the route would let a 300-character title reach MariaDB and come back as
// a 500.

// admin_id on create. Present because an OWNER creating a course must say whose
// it is -- they own no roster themselves, so there is no sensible default for
// them. A teacher omits it and the route fills in their own id.
//
// Optional here, NOT NULL in the column: whether a missing value is acceptable
// depends on who is asking, which is exactly the kind of question a schema
// cannot answer. The route rejects an owner who omits it.
const optionalAdminIdSchema = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/, 'must be a numeric id')])
  .transform(Number)
  .optional();

const createCourseSchema = z.object({
  title: z.string().trim().min(1).max(255),
  // Nullable, matching the column. A course named "Grade 3 Repertoire" needs no
  // paragraph under it to be useful.
  description: z.string().trim().max(5000).nullable().optional(),
  admin_id: optionalAdminIdSchema
});

// PATCH: every field optional, but at least one present.
//
// Without the refine, `PATCH {}` is a well-formed request that updates nothing
// and answers 200, which reads to a client as a successful save. Rejecting it
// makes "nothing happened" impossible to mistake for "your change was stored".
const updateCourseSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    // Archiving is the delete: 0030's header argues a finished term's course
    // still owns its assignments and submissions, so it is hidden rather than
    // removed.
    status: z.enum(['active', 'archived']).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided'
  });

const enrollStudentSchema = z.object({
  student_id: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/, 'must be a numeric id')])
    .transform(Number)
});

const courseIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid course id')
});

const enrollmentParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid course id'),
  studentId: z.string().regex(/^\d+$/, 'Invalid student id')
});

const listCoursesQuerySchema = z.object({
  status: z.enum(['active', 'archived']).optional()
});

// The confirmation gate on hard delete.
//
// A literal 'true' string, because this arrives as a query parameter and
// z.coerce.boolean() would accept 'false', '0' and '' as true -- every non-empty
// string is truthy. On a destructive irreversible endpoint the parse must be
// exact rather than forgiving.
//
// The gate is enforced SERVER-side rather than trusting the client to have
// shown a dialog: the route answers 409 with the counts, and only a second
// request carrying confirm=true proceeds. A client that never asks the user
// simply gets a 409 it has to handle.
const deleteCourseQuerySchema = z.object({
  confirm: z.literal('true').optional()
});

module.exports = {
  createCourseSchema,
  updateCourseSchema,
  enrollStudentSchema,
  courseIdParamSchema,
  enrollmentParamSchema,
  listCoursesQuerySchema,
  deleteCourseQuerySchema
};
