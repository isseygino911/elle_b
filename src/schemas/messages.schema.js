const { z } = require('zod');

const studentIdParamSchema = z.object({
  studentId: z.string().regex(/^\d+$/, 'Invalid student id')
});

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(5000)
});

module.exports = { studentIdParamSchema, sendMessageSchema };
