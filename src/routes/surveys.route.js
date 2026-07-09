const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireRole, requireAuth } = require('../middleware/auth');
const { uploadSurveyFile } = require('../middleware/upload');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  uploadMetadataSchema,
  surveyIdParamSchema,
  surveyQuestionParamsSchema,
  surveyDetailQuerySchema,
  submitAnswerSchema
} = require('../schemas/surveys.schema');
const { parseSurveyXml, SurveyXmlError } = require('../services/surveyXmlParser');
const s3 = require('../services/s3');
const { sanitizeFilename } = require('../utils/sanitizeFilename');
const { DOWNLOAD_URL_EXPIRES_IN_SECONDS } = s3;

const router = express.Router();

// Shapes a `surveys` row for API responses — omits the internal s3_key
// (downloads go through the dedicated /download-url endpoint instead).
function serializeSurvey(row) {
  return {
    id: row.id,
    title: row.title,
    original_filename: row.original_filename,
    uploaded_at: row.uploaded_at
  };
}

function serializeQuestion(row) {
  return {
    id: row.id,
    order_index: row.order_index,
    question_text: row.question_text,
    points: row.points
  };
}

function serializeAnswer(row) {
  return {
    id: row.id,
    order_index: row.order_index,
    answer_text: row.answer_text,
    points: row.points,
    category: row.category
  };
}

function serializeResponse(row) {
  return {
    id: row.id,
    answer_id: row.answer_id,
    points_earned: row.points_earned,
    submitted_at: row.submitted_at
  };
}

// Loads a survey's questions plus each question's answers (if any) and
// merges them into `{ ...question, answers: [...] }` rows, ordered the same
// way GET /:id and POST / have always returned questions. `runner` is
// either the pool or a transaction connection — both expose `.query()`.
async function loadQuestionsWithAnswers(runner, surveyId) {
  const [questionRows] = await runner.query(
    'SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY order_index',
    [surveyId]
  );

  if (questionRows.length === 0) {
    return [];
  }

  const [answerRows] = await runner.query(
    'SELECT * FROM survey_answers WHERE question_id IN (?) ORDER BY question_id, order_index',
    [questionRows.map((row) => row.id)]
  );

  const answersByQuestionId = new Map();
  for (const row of answerRows) {
    if (!answersByQuestionId.has(row.question_id)) {
      answersByQuestionId.set(row.question_id, []);
    }
    answersByQuestionId.get(row.question_id).push(serializeAnswer(row));
  }

  return questionRows.map((row) => ({
    ...serializeQuestion(row),
    answers: answersByQuestionId.get(row.id) || []
  }));
}

// Mutates `questions` (as returned by loadQuestionsWithAnswers) in place,
// adding `submission` and `locked` to each one. Not part of
// loadQuestionsWithAnswers itself so that POST / (upload) — which reuses
// loadQuestionsWithAnswers for its own response — stays unaffected; only
// callers that actually want submission/lock state opt in by calling this
// too.
//
// Walks the answerable subset (answers.length > 0) in order_index order:
// every question at or before the first one with no response yet is
// unlocked (with its submission attached, if any); everything after that
// first gap is locked. Non-answerable ("flat") questions never participate
// and are always unlocked with no submission.
function attachLockState(questions, responsesByQuestionId) {
  let gapFound = false;

  for (const question of questions) {
    if (question.answers.length === 0) {
      question.locked = false;
      question.submission = null;
      continue;
    }

    const response = responsesByQuestionId.get(question.id);

    if (gapFound) {
      question.locked = true;
      question.submission = null;
    } else if (response) {
      question.locked = false;
      question.submission = serializeResponse(response);
    } else {
      question.locked = false;
      question.submission = null;
      gapFound = true;
    }
  }

  return questions;
}

// Loads every survey_responses row for a survey and a specific student,
// keyed by question_id — the same lookup both GET /:id (lock state) and the
// submit endpoint (ordering/already-submitted checks) need. Each student's
// progress on a survey is independent, so this is always scoped to one
// student_id.
async function loadResponsesByQuestionId(runner, surveyId, studentId) {
  const [responseRows] = await runner.query(
    'SELECT * FROM survey_responses WHERE survey_id = ? AND student_id = ?',
    [surveyId, studentId]
  );

  return new Map(responseRows.map((row) => [row.question_id, row]));
}

// Shared by GET /:id and GET /:id/download-url: loads the survey by id.
// Surveys have no ownership anymore — any authenticated user can view any
// survey — so this just checks existence. Returns the survey row, or null
// after already sending the response.
async function loadAuthorizedSurvey(req, res) {
  const [rows] = await pool.query('SELECT * FROM surveys WHERE id = ?', [req.params.id]);
  const survey = rows[0];

  if (!survey) {
    res.status(404).json({ status: 'error', message: 'Survey not found' });
    return null;
  }

  return survey;
}

router.post(
  '/',
  requireRole('elle'),
  uploadSurveyFile('file'),
  validateBody(uploadMetadataSchema),
  async (req, res, next) => {
    const { title } = req.body;

    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'Survey XML file is required' });
    }

    try {
      let questions;
      try {
        questions = parseSurveyXml(req.file.buffer);
      } catch (err) {
        if (err instanceof SurveyXmlError) {
          return res.status(400).json({ status: 'error', message: err.message });
        }
        throw err;
      }

      const s3Key = `surveys/${crypto.randomUUID()}/${sanitizeFilename(req.file.originalname)}`;

      try {
        await s3.putSurveyObject(s3Key, req.file.buffer, req.file.mimetype);
      } catch (err) {
        console.error('S3 putSurveyObject failed:', err);
        return res.status(502).json({ status: 'error', message: 'Failed to store survey file' });
      }

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        const [insertResult] = await connection.query(
          `INSERT INTO surveys (title, s3_key, original_filename)
           VALUES (?, ?, ?)`,
          [title, s3Key, req.file.originalname]
        );
        const surveyId = insertResult.insertId;

        const [questionsInsertResult] = await connection.query(
          `INSERT INTO survey_questions (survey_id, order_index, question_text, points)
           VALUES ?`,
          [questions.map((q) => [surveyId, q.order_index, q.question_text, q.points])]
        );

        // The multi-row INSERT above is a "simple insert" (fixed, known row
        // count), which MySQL/InnoDB guarantees a contiguous block of
        // auto-increment ids for -- even under innodb_autoinc_lock_mode=2
        // (interleaved, the MySQL 8 default) -- so the Nth question row got
        // id = questionsInsertResult.insertId + N. This lets us build the
        // answers rows below without a round-trip to re-fetch each
        // question's id.
        const firstQuestionId = questionsInsertResult.insertId;

        const answerRows = [];
        questions.forEach((question, index) => {
          const questionId = firstQuestionId + index;
          question.answers.forEach((answer, answerIndex) => {
            answerRows.push([questionId, answerIndex, answer.answer_text, answer.points, answer.category]);
          });
        });

        if (answerRows.length > 0) {
          await connection.query(
            `INSERT INTO survey_answers (question_id, order_index, answer_text, points, category)
             VALUES ?`,
            [answerRows]
          );
        }

        await connection.commit();

        const [surveyRows] = await connection.query('SELECT * FROM surveys WHERE id = ?', [surveyId]);
        const questionsWithAnswers = await loadQuestionsWithAnswers(connection, surveyId);

        res.status(201).json({
          survey: serializeSurvey(surveyRows[0]),
          questions: questionsWithAnswers
        });
      } catch (err) {
        await connection.rollback();
        next(err);
      } finally {
        connection.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM surveys ORDER BY uploaded_at DESC');

    res.status(200).json({ surveys: rows.map(serializeSurvey) });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:id',
  requireAuth(),
  validateParams(surveyIdParamSchema),
  validateQuery(surveyDetailQuerySchema),
  async (req, res, next) => {
    try {
      const survey = await loadAuthorizedSurvey(req, res);
      if (!survey) {
        return;
      }

      const questionsWithAnswers = await loadQuestionsWithAnswers(pool, survey.id);

      const studentId = req.user.role === 'student' ? req.user.id : req.query.student_id;

      if (studentId) {
        const responsesByQuestionId = await loadResponsesByQuestionId(pool, survey.id, studentId);
        attachLockState(questionsWithAnswers, responsesByQuestionId);
      } else {
        for (const question of questionsWithAnswers) {
          question.locked = false;
          question.submission = null;
        }
      }

      res.status(200).json({
        survey: serializeSurvey(survey),
        questions: questionsWithAnswers
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/:id/questions/:questionId/submit',
  requireRole('student'),
  validateParams(surveyQuestionParamsSchema),
  validateBody(submitAnswerSchema),
  async (req, res, next) => {
    try {
      const survey = await loadAuthorizedSurvey(req, res);
      if (!survey) {
        return;
      }

      const questions = await loadQuestionsWithAnswers(pool, survey.id);
      const question = questions.find((q) => q.id === Number(req.params.questionId));

      if (!question) {
        return res.status(404).json({ status: 'error', message: 'Question not found' });
      }

      if (question.answers.length === 0) {
        return res.status(400).json({ status: 'error', message: 'This question does not accept a submission' });
      }

      const answer = question.answers.find((a) => a.id === req.body.answer_id);
      if (!answer) {
        return res.status(400).json({ status: 'error', message: 'answer_id does not belong to this question' });
      }

      const responsesByQuestionId = await loadResponsesByQuestionId(pool, survey.id, req.user.id);
      attachLockState(questions, responsesByQuestionId);

      if (question.submission) {
        return res.status(409).json({ status: 'error', message: 'This day has already been submitted' });
      }

      if (question.locked) {
        return res.status(400).json({ status: 'error', message: 'Complete the previous day before submitting this one.' });
      }

      let insertResult;
      try {
        [insertResult] = await pool.query(
          `INSERT INTO survey_responses (survey_id, question_id, student_id, answer_id, points_earned)
           VALUES (?, ?, ?, ?, ?)`,
          [survey.id, question.id, req.user.id, answer.id, answer.points]
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ status: 'error', message: 'This day has already been submitted' });
        }
        throw err;
      }

      const [responseRows] = await pool.query('SELECT * FROM survey_responses WHERE id = ?', [insertResult.insertId]);

      res.status(201).json({ response: serializeResponse(responseRows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id/download-url',
  requireAuth(),
  validateParams(surveyIdParamSchema),
  async (req, res, next) => {
    try {
      const survey = await loadAuthorizedSurvey(req, res);
      if (!survey) {
        return;
      }

      let url;
      try {
        url = await s3.getSurveyDownloadUrl(survey.s3_key);
      } catch (err) {
        console.error('S3 getSurveyDownloadUrl failed:', err);
        return res.status(502).json({ status: 'error', message: 'Failed to generate download URL' });
      }

      res.status(200).json({ url, expires_in: DOWNLOAD_URL_EXPIRES_IN_SECONDS });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:id',
  requireRole('elle'),
  validateParams(surveyIdParamSchema),
  async (req, res, next) => {
    try {
      const [rows] = await pool.query('SELECT * FROM surveys WHERE id = ?', [req.params.id]);
      const survey = rows[0];

      if (!survey) {
        return res.status(404).json({ status: 'error', message: 'Survey not found' });
      }

      try {
        await s3.deleteSurveyObject(survey.s3_key);
      } catch (err) {
        console.error('S3 deleteSurveyObject failed:', err);
      }

      await pool.query('DELETE FROM surveys WHERE id = ?', [survey.id]);

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
