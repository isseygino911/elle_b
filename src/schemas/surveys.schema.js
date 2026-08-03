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

const numericId = z
  .union([z.number().int().positive(), z.string().regex(/^\d+$/, 'must be a numeric id')])
  .transform(Number);

// A day is submitted all at once: every statement in it carries its own
// 1..N rating (see services/surveyXmlParser.js for why an <answer> is a
// rateable statement rather than a choice).
//
// Only the shape and the universal lower bound are checked here. The upper
// bound is deliberately NOT enforced in zod: each statement's maximum is
// its own survey_answers.points value, which is DB state this schema
// cannot see. routes/surveys.route.js checks each rating against its own
// answer's points, and also verifies that `ratings` covers exactly the
// question's statements — no missing, extra, or duplicated ones.
const submitRatingsSchema = z.object({
  ratings: z
    .array(
      z.object({
        answer_id: numericId,
        rating: z
          .union([z.number().int(), z.string().regex(/^\d+$/, 'must be a number')])
          .transform(Number)
          .pipe(z.number().int().min(1, 'rating must be at least 1'))
      })
    )
    .min(1, 'ratings must not be empty')
});

module.exports = {
  uploadMetadataSchema,
  surveyIdParamSchema,
  surveyQuestionParamsSchema,
  surveyDetailQuerySchema,
  submitRatingsSchema
};
