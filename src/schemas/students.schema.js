// zod schema for the students/ route's route params.

const { z } = require('zod');

const studentIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid student id')
});

module.exports = {
  studentIdParamSchema
};
