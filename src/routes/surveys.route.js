const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireRole, requireAuth, requireCapability } = require('../middleware/auth');
const { uploadSurveyFile } = require('../middleware/upload');
const { ROLES, CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  uploadMetadataSchema,
  surveyIdParamSchema,
  surveyQuestionParamsSchema,
  surveyDetailQuerySchema,
  submitRatingsSchema
} = require('../schemas/surveys.schema');
const { parseSurveyXml, SurveyXmlError } = require('../services/surveyXmlParser');
const s3 = require('../services/s3');
const { sanitizeFilename } = require('../utils/sanitizeFilename');
const { assertStudentInScope } = require('../utils/students');
const { DOWNLOAD_URL_EXPIRES_IN_SECONDS } = s3;

const router = express.Router();

// Shapes a `surveys` row for API responses — omits the internal s3_key
// (downloads go through the dedicated /download-url endpoint instead).
function serializeSurvey(row) {
  return {
    id: row.id,
    title: row.title,
    title_zh: row.title_zh,
    original_filename: row.original_filename,
    uploaded_at: row.uploaded_at
  };
}

function serializeQuestion(row) {
  return {
    id: row.id,
    order_index: row.order_index,
    question_text: row.question_text,
    question_text_zh: row.question_text_zh,
    points: row.points
  };
}

function serializeAnswer(row) {
  return {
    id: row.id,
    order_index: row.order_index,
    answer_text: row.answer_text,
    answer_text_zh: row.answer_text_zh,
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

// Collapses a day's per-statement survey_responses rows into the single
// `submission` object the client reads. A day is rated all at once, so its
// rows share a submitted_at and are only ever surfaced together.
//
// `points_earned` is the sum of the day's ratings, which keeps every
// existing consumer working unchanged (the client's points-earned tally and
// its progress bar both read submission.points_earned against the day's
// max, question.points) while `ratings` carries the per-statement detail
// the rating UI needs to show what the student actually picked.
function serializeSubmission(rows) {
  return {
    ratings: rows.map(serializeResponse),
    points_earned: rows.reduce((sum, row) => sum + row.points_earned, 0),
    submitted_at: rows.reduce(
      (latest, row) => (latest === null || row.submitted_at > latest ? row.submitted_at : latest),
      null
    )
  };
}

// Loads a survey's questions plus each question's answers (if any) and
// merges them into `{ ...question, answers: [...] }` rows, ordered the same
// way GET /:id and POST / have always returned questions. `runner` is
// either the pool or a transaction connection — both expose `.query()`.
//
// `orgId` is redundant given every caller resolves `surveyId` through an
// org-fenced load first, but both child tables carry org_id (0023) so the
// predicate is free — and it means a future caller that forgets to fence the
// parent still can't read across organizations.
async function loadQuestionsWithAnswers(runner, surveyId, orgId) {
  const [questionRows] = await runner.query(
    'SELECT * FROM survey_questions WHERE survey_id = ? AND org_id = ? ORDER BY order_index',
    [surveyId, orgId]
  );

  if (questionRows.length === 0) {
    return [];
  }

  const [answerRows] = await runner.query(
    'SELECT * FROM survey_answers WHERE question_id IN (?) AND org_id = ? ORDER BY question_id, order_index',
    [questionRows.map((row) => row.id), orgId]
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
// adding `submission` to each one. Not part of loadQuestionsWithAnswers
// itself so that POST / (upload) — which reuses loadQuestionsWithAnswers
// for its own response — stays unaffected; only callers that actually want
// submission state opt in by calling this too.
//
// Days are independent: a student may rate them in any order, so there is
// no sequential gate and every answerable day is always available. A day
// that has been submitted carries its `submission`; one that hasn't gets
// null.
//
// A day counts as submitted only when EVERY one of its statements has been
// rated -- each statement is its own survey_responses row, so a complete
// day has as many rows as it has answers. A partially-rated day (only
// reachable if a submit transaction half-failed) deliberately counts as
// unsubmitted, so the student can submit it again rather than being
// stranded on a day that can never complete.
function attachSubmissions(questions, responsesByQuestionId) {
  for (const question of questions) {
    if (question.answers.length === 0) {
      question.submission = null;
      continue;
    }

    const responses = responsesByQuestionId.get(question.id) || [];
    const isComplete = responses.length === question.answers.length;

    question.submission = isComplete ? serializeSubmission(responses) : null;
  }

  return questions;
}

// Loads every survey_responses row for a survey and a specific student,
// grouped into an array per question_id — the same lookup both GET /:id
// (lock state) and the submit endpoint (ordering/already-submitted checks)
// need. Each student's progress on a survey is independent, so this is
// always scoped to one student_id.
//
// The value is an array rather than a single row because a day is rated
// statement by statement: one row per survey_answers row, not one per
// question (see migrations/0014_survey_responses_per_answer.sql). Ordered
// by answer_id so a day's ratings come back in a stable order.
async function loadResponsesByQuestionId(runner, surveyId, studentId) {
  const [responseRows] = await runner.query(
    'SELECT * FROM survey_responses WHERE survey_id = ? AND student_id = ? ORDER BY question_id, answer_id',
    [surveyId, studentId]
  );

  const responsesByQuestionId = new Map();
  for (const row of responseRows) {
    if (!responsesByQuestionId.has(row.question_id)) {
      responsesByQuestionId.set(row.question_id, []);
    }
    responsesByQuestionId.get(row.question_id).push(row);
  }

  return responsesByQuestionId;
}

// Shared by GET /:id, GET /:id/download-url and DELETE /:id: loads the survey
// by id, fenced to the caller's organization.
//
// Surveys have no per-teacher owner — migration 0012 dropped student_id, and
// 0023 kept surveys org-level curriculum every student can take — so the fence
// is org_id and nothing else. That is deliberately NOT scopeFor(): a student
// caller would throw there (scope.js demands a `student` column this table
// doesn't have), and students must reach their own org's surveys to take them.
//
// A survey in another organization gets a 404, not a 403, so ids can't be
// probed for existence.
async function loadAuthorizedSurvey(req, res) {
  const [rows] = await pool.query('SELECT * FROM surveys WHERE id = ? AND org_id = ?', [
    req.params.id,
    req.user.orgId
  ]);
  const survey = rows[0];

  if (!survey) {
    res.status(404).json({ status: 'error', message: 'Survey not found' });
    return null;
  }

  return survey;
}

router.post(
  '/',
  requireCapability(CAN_READ_STUDENT_DETAIL),
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
          `INSERT INTO surveys (org_id, title, s3_key, original_filename)
           VALUES (?, ?, ?, ?)`,
          [req.user.orgId, title, s3Key, req.file.originalname]
        );
        const surveyId = insertResult.insertId;

        const [questionsInsertResult] = await connection.query(
          `INSERT INTO survey_questions (org_id, survey_id, order_index, question_text, points)
           VALUES ?`,
          [questions.map((q) => [req.user.orgId, surveyId, q.order_index, q.question_text, q.points])]
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
            answerRows.push([
              req.user.orgId,
              questionId,
              answerIndex,
              answer.answer_text,
              answer.points,
              answer.category
            ]);
          });
        });

        if (answerRows.length > 0) {
          await connection.query(
            `INSERT INTO survey_answers (org_id, question_id, order_index, answer_text, points, category)
             VALUES ?`,
            [answerRows]
          );
        }

        await connection.commit();

        const [surveyRows] = await connection.query(
          'SELECT * FROM surveys WHERE id = ? AND org_id = ?',
          [surveyId, req.user.orgId]
        );
        const questionsWithAnswers = await loadQuestionsWithAnswers(
          connection,
          surveyId,
          req.user.orgId
        );

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
    const [rows] = await pool.query(
      'SELECT * FROM surveys WHERE org_id = ? ORDER BY uploaded_at DESC',
      [req.user.orgId]
    );

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

      const questionsWithAnswers = await loadQuestionsWithAnswers(
        pool,
        survey.id,
        req.user.orgId
      );

      // A student always sees their own answers and cannot ask for anyone
      // else's -- ?student_id= is ignored for them rather than honoured.
      //
      // The route is requireAuth(), NOT requireCapability: a student has to
      // reach their own org's survey to take it. So the per-student boundary
      // is enforced here instead, by assertStudentInScope -- which returns
      // null for a manager unconditionally, for a student outside the
      // caller's org, and for a student off an admin's own roster. An
      // individual student's answers are exactly the per-student detail the
      // manager role must never see.
      //
      // Out of scope is a 404, matching the survey load above: an id that
      // isn't yours reads as absent rather than forbidden.
      let studentId = null;
      if (req.user.role === ROLES.STUDENT) {
        studentId = req.user.id;
      } else if (req.query.student_id) {
        const student = await assertStudentInScope(req.user, req.query.student_id);
        if (!student) {
          return res.status(404).json({ status: 'error', message: 'Survey not found' });
        }
        studentId = student.id;
      }

      if (studentId) {
        const responsesByQuestionId = await loadResponsesByQuestionId(pool, survey.id, studentId);
        attachSubmissions(questionsWithAnswers, responsesByQuestionId);
      } else {
        for (const question of questionsWithAnswers) {
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

// Submits one whole day at once: every statement in the question carries
// its own 1..N rating. All-or-nothing -- a day is never left half-rated,
// because attachSubmissions only treats a day as complete when it has a row
// for every statement, so a partial write would leave that day reading as
// unsubmitted. Days may be submitted in any order, but each only once.
router.post(
  '/:id/questions/:questionId/submit',
  requireRole(ROLES.STUDENT),
  validateParams(surveyQuestionParamsSchema),
  validateBody(submitRatingsSchema),
  async (req, res, next) => {
    try {
      const survey = await loadAuthorizedSurvey(req, res);
      if (!survey) {
        return;
      }

      const questions = await loadQuestionsWithAnswers(pool, survey.id, req.user.orgId);
      const question = questions.find((q) => q.id === Number(req.params.questionId));

      if (!question) {
        return res.status(404).json({ status: 'error', message: 'Question not found' });
      }

      if (question.answers.length === 0) {
        return res.status(400).json({ status: 'error', message: 'This question does not accept a submission' });
      }

      const { ratings } = req.body;

      // The submitted set must match this day's statements exactly:
      // duplicates first (they would otherwise mask a missing statement by
      // keeping the counts equal), then unknown ids, then completeness.
      const submittedIds = ratings.map((entry) => entry.answer_id);
      if (new Set(submittedIds).size !== submittedIds.length) {
        return res.status(400).json({ status: 'error', message: 'Each statement may only be rated once' });
      }

      const answersById = new Map(question.answers.map((answer) => [answer.id, answer]));
      const unknownId = submittedIds.find((id) => !answersById.has(id));
      if (unknownId !== undefined) {
        return res.status(400).json({ status: 'error', message: 'answer_id does not belong to this question' });
      }

      if (submittedIds.length !== question.answers.length) {
        return res.status(400).json({ status: 'error', message: 'Rate every statement before submitting this day' });
      }

      // Each statement's scale runs 1..its own points, so the ceiling is
      // per-statement and can't live in the zod schema (which enforces only
      // the integer >= 1 floor).
      for (const entry of ratings) {
        const answer = answersById.get(entry.answer_id);
        if (entry.rating > answer.points) {
          return res.status(400).json({
            status: 'error',
            message: `Rating for "${answer.answer_text}" must be between 1 and ${answer.points}`
          });
        }
      }

      const responsesByQuestionId = await loadResponsesByQuestionId(pool, survey.id, req.user.id);
      attachSubmissions(questions, responsesByQuestionId);

      if (question.submission) {
        return res.status(409).json({ status: 'error', message: 'This day has already been submitted' });
      }

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        // A half-rated day is indistinguishable from an unsubmitted one, so
        // all of the day's rows land together or none of them do.
        await connection.query(
          `INSERT INTO survey_responses (survey_id, question_id, student_id, answer_id, points_earned)
           VALUES ?`,
          [ratings.map((entry) => [survey.id, question.id, req.user.id, entry.answer_id, entry.rating])]
        );

        await connection.commit();
      } catch (err) {
        await connection.rollback();

        // Two concurrent submissions of the same day: whichever loses the
        // race trips uq_survey_responses_answer_id_student_id.
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ status: 'error', message: 'This day has already been submitted' });
        }
        throw err;
      } finally {
        connection.release();
      }

      const [responseRows] = await pool.query(
        'SELECT * FROM survey_responses WHERE question_id = ? AND student_id = ? ORDER BY answer_id',
        [question.id, req.user.id]
      );

      res.status(201).json({ submission: serializeSubmission(responseRows) });
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
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateParams(surveyIdParamSchema),
  async (req, res, next) => {
    try {
      // Uses the org-fenced loader rather than its own SELECT, so a survey in
      // another organization 404s BEFORE the S3 object is destroyed below.
      const survey = await loadAuthorizedSurvey(req, res);
      if (!survey) {
        return;
      }

      try {
        await s3.deleteSurveyObject(survey.s3_key);
      } catch (err) {
        console.error('S3 deleteSurveyObject failed:', err);
      }

      await pool.query('DELETE FROM surveys WHERE id = ? AND org_id = ?', [
        survey.id,
        req.user.orgId
      ]);

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
