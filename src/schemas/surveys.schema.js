// zod schemas for the surveys/ route — multipart metadata fields and route
// params. XML file content itself is validated separately by
// services/surveyXmlParser.js.

const { z } = require('zod');

const uploadMetadataSchema = z.object({
  title: z.string().trim().min(1).max(255)
});

const surveyIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid survey id')
});

const surveyQuestionParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Invalid survey id'),
  questionId: z.string().regex(/^\d+$/, 'Invalid question id')
});

const surveyDetailQuerySchema = z.object({
  student_id: z
    .string()
    .regex(/^\d+$/, 'student_id must be a numeric id')
    .optional()
});

const submitAnswerSchema = z.object({
  answer_id: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/, 'must be a numeric id')])
    .transform(Number)
});

module.exports = {
  uploadMetadataSchema,
  surveyIdParamSchema,
  surveyQuestionParamsSchema,
  surveyDetailQuerySchema,
  submitAnswerSchema
};
