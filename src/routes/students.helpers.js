// Shared by students.route.js's GET /:id/scores and dashboard.route.js's
// student_progress section, so "what counts as a survey's max possible
// score" and "how far along is a student" each live in exactly one place.
//
// Scoring only ever covers answerable ("nested", per surveyXmlParser.js)
// questions -- ones with survey_answers rows. "Flat" questions never get a
// survey_responses row (see 0011_create_survey_responses.sql), so they're
// excluded from every total here via the EXISTS check in getSurveyTotals,
// matching the client's existing answerableQuestions filter
// (SurveyDetailPage.jsx).

const pool = require('../db/pool');

// One survey_questions<->survey_answers join, computed once and reused by
// both functions below -- the single source of truth for "how many
// answerable questions does survey X have, and how many points can it earn
// in total".
// SUM() over an integer column comes back from mysql2 as a DECIMAL/BIGINT
// -- a string, not a number, since mysql2 doesn't assume it's safe to
// auto-convert. CAST(... AS UNSIGNED) forces MySQL to return a plain
// integer type instead, which mysql2 does convert to a JS number.
async function getSurveyTotals() {
  const [rows] = await pool.query(
    `SELECT sq.survey_id, s.title, s.title_zh, COUNT(*) AS total_questions,
            CAST(SUM(sq.points) AS UNSIGNED) AS total_points
     FROM survey_questions sq
     JOIN surveys s ON s.id = sq.survey_id
     WHERE EXISTS (SELECT 1 FROM survey_answers sa WHERE sa.question_id = sq.id)
     GROUP BY sq.survey_id, s.title, s.title_zh`
  );
  return rows;
}

// This student's progress broken out per survey -- used by the Students
// detail page.
async function computeStudentSurveyScores(studentId) {
  const surveyTotals = await getSurveyTotals();

  const [responseRows] = await pool.query(
    `SELECT survey_id, COUNT(*) AS completed_questions,
            CAST(SUM(points_earned) AS UNSIGNED) AS earned_points,
            MAX(submitted_at) AS last_submitted_at
     FROM survey_responses
     WHERE student_id = ?
     GROUP BY survey_id`,
    [studentId]
  );
  const responsesBySurveyId = new Map(responseRows.map((row) => [row.survey_id, row]));

  return surveyTotals.map((survey) => {
    const response = responsesBySurveyId.get(survey.survey_id);
    return {
      survey_id: survey.survey_id,
      title: survey.title,
      title_zh: survey.title_zh,
      total_questions: survey.total_questions,
      total_points: survey.total_points,
      completed_questions: response ? response.completed_questions : 0,
      earned_points: response ? response.earned_points : 0,
      last_submitted_at: response ? response.last_submitted_at : null
    };
  });
}

// Every student's overall progress across all surveys combined -- used by
// the Students list panel and the dashboard's student_progress widget.
// Sorted ascending by completion ratio so the students furthest behind
// surface first.
async function computeAllStudentsProgress() {
  const surveyTotals = await getSurveyTotals();
  const totalQuestions = surveyTotals.reduce((sum, survey) => sum + survey.total_questions, 0);
  const totalPoints = surveyTotals.reduce((sum, survey) => sum + survey.total_points, 0);

  const [studentRows] = await pool.query(
    "SELECT id, name FROM users WHERE role = 'student' ORDER BY name"
  );

  const [responseRows] = await pool.query(
    `SELECT student_id, COUNT(*) AS completed_questions,
            CAST(SUM(points_earned) AS UNSIGNED) AS earned_points,
            MAX(submitted_at) AS last_submitted_at
     FROM survey_responses
     GROUP BY student_id`
  );
  const responsesByStudentId = new Map(responseRows.map((row) => [row.student_id, row]));

  const progress = studentRows.map((student) => {
    const response = responsesByStudentId.get(student.id);
    const completedQuestions = response ? response.completed_questions : 0;

    return {
      student_id: student.id,
      student_name: student.name,
      completed_questions: completedQuestions,
      total_questions: totalQuestions,
      earned_points: response ? response.earned_points : 0,
      total_points: totalPoints,
      completion_ratio: totalQuestions > 0 ? completedQuestions / totalQuestions : 0,
      last_submitted_at: response ? response.last_submitted_at : null
    };
  });

  progress.sort((a, b) => a.completion_ratio - b.completion_ratio);
  return progress;
}

module.exports = {
  computeStudentSurveyScores,
  computeAllStudentsProgress
};
