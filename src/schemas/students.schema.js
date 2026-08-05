// zod schemas for the students/ route's params and bodies.

const { z } = require('zod');

const studentIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid student id')
});

// Body of PATCH /students/:id/admin -- reassigns a student to a teacher.
//
// admin_id is nullable ON PURPOSE. Migration 0017 makes users.admin_id
// NULLABLE because a student invited by an owner has no teacher until one is
// chosen, and because deleting a teacher SET NULLs their students rather than
// cascade-deleting them. Unassigning must therefore be expressible here, or
// those states could be entered but never deliberately exited.
//
// z.null() rather than .optional(): an absent key and an explicit null are
// different intents, and only the latter means "unassign". An absent key is a
// malformed request, not a silent unassign.
const reassignStudentSchema = z.object({
  admin_id: z.union([
    z.number().int().positive(),
    z.null()
  ])
});

module.exports = {
  studentIdParamSchema,
  reassignStudentSchema
};
