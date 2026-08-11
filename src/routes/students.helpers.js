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
//
// Counting note: an answerable question is one DAY, but a day is stored as
// one survey_responses row PER STATEMENT (see
// 0014_survey_responses_per_answer.sql), so a five-statement day produces
// five rows. Progress is measured in days, which is why the completed
// counts below are COUNT(DISTINCT question_id) rather than COUNT(*) -- the
// latter would report a single finished day as five completed questions
// and overstate progress fivefold. Points are unaffected: SUM(points_earned)
// sums the student's actual per-statement ratings, and the denominator
// SUM(sq.points) is each day's max (itself the sum of its statements'
// maxima, computed by surveyXmlParser.js), so both sides are on the same
// scale.

const pool = require('../db/pool');
const { scopeFor } = require('../utils/scope');

// One survey_questions<->survey_answers join, computed once and reused by
// both functions below -- the single source of truth for "how many
// answerable questions does survey X have, and how many points can it earn
// in total".
// SUM() over an integer column comes back from mysql2 as a DECIMAL/BIGINT
// -- a string, not a number, since mysql2 doesn't assume it's safe to
// auto-convert. CAST(... AS UNSIGNED) forces MySQL to return a plain
// integer type instead, which mysql2 does convert to a JS number.
//
// `orgId` fences this to one organization's curriculum. Without it the totals
// spanned every tenant: other organizations' survey TITLES leaked into the
// scores response, and -- worse -- their questions inflated the denominator in
// computeAllStudentsProgress, so every student's completion ratio read far
// lower than reality.
//
// `surveyId` narrows to a single survey. Optional because the two callers want
// different things: computeStudentSurveyScores wants every survey (it renders
// the per-survey breakdown), while a roster measured against one survey wants
// only that one. See computeAllStudentsProgress for why that distinction
// matters.
async function getSurveyTotals(orgId, surveyId = null) {
  const conditions = ['s.org_id = ?'];
  const params = [orgId];

  if (surveyId != null) {
    conditions.push('s.id = ?');
    params.push(surveyId);
  }

  const [rows] = await pool.query(
    `SELECT sq.survey_id, s.title, s.title_zh, COUNT(*) AS total_questions,
            CAST(SUM(sq.points) AS UNSIGNED) AS total_points
     FROM survey_questions sq
     JOIN surveys s ON s.id = sq.survey_id
     WHERE ${conditions.join(' AND ')}
       AND EXISTS (SELECT 1 FROM survey_answers sa WHERE sa.question_id = sq.id)
     GROUP BY sq.survey_id, s.title, s.title_zh`,
    params
  );
  return rows;
}

// The survey a roster is measured against by default: the most recently
// uploaded one, matching GET /surveys' own ORDER BY uploaded_at DESC.
//
// Returns null for an org that has uploaded nothing, which callers must treat
// as "no progress to show" rather than as 0% -- a studio with no curriculum
// has not fallen behind on it.
async function getDefaultSurveyId(orgId) {
  const [rows] = await pool.query(
    'SELECT id FROM surveys WHERE org_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT 1',
    [orgId]
  );
  return rows.length > 0 ? rows[0].id : null;
}

// Every survey in the org, for the dashboard's survey picker. Title only --
// the picker needs to name them, not to score them.
async function listSurveyOptions(orgId) {
  const [rows] = await pool.query(
    'SELECT id, title, title_zh FROM surveys WHERE org_id = ? ORDER BY uploaded_at DESC, id DESC',
    [orgId]
  );
  return rows;
}

// This student's progress broken out per survey -- used by the Students
// detail page.
//
// `orgId` is the STUDENT's org, which assertStudentInScope has already proved
// equal to the caller's before this runs.
async function computeStudentSurveyScores(studentId, orgId) {
  const surveyTotals = await getSurveyTotals(orgId);

  // survey_responses deliberately has no org_id (migration 0023) -- the fence
  // comes from joining through surveys instead, so the two can never disagree.
  const [responseRows] = await pool.query(
    `SELECT r.survey_id, COUNT(DISTINCT r.question_id) AS completed_questions,
            CAST(SUM(r.points_earned) AS UNSIGNED) AS earned_points,
            MAX(r.submitted_at) AS last_submitted_at
     FROM survey_responses r
     JOIN surveys s ON s.id = r.survey_id
     WHERE r.student_id = ? AND s.org_id = ?
     GROUP BY r.survey_id`,
    [studentId, orgId]
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
// `user` scopes the roster: an admin sees only their own students, an owner
// the whole organization. Previously this selected EVERY student row in the
// database with no predicate at all, which under multi-tenancy would have
// shown one organization's progress table to another's.
//
// `surveyId` measures the roster against ONE survey instead of the whole
// corpus. Optional, and omitting it preserves the original all-surveys
// behaviour exactly -- GET /students/progress still calls it that way.
//
// Why the option exists: summing every survey into one denominator makes the
// ratio mean "fraction of the org's entire accumulated question corpus this
// student has answered", which is not what a progress bar is read as. A
// student who finishes survey A but has not been given B or C reads 33%, and
// uploading a new survey retroactively drops every existing student's number
// -- the denominator grows for everyone while the numerators stay put. Since
// the sort below is ascending and the dashboard slices the first few,
// students who were simply never assigned the newer surveys crowd out the
// ones actually falling behind.
//
// There is no is_active/assigned flag on surveys to filter by (migration 0012
// dropped surveys.student_id and nothing replaced it), so which survey to
// measure against cannot be derived -- it has to be passed in.
async function computeAllStudentsProgress(user, { surveyId = null } = {}) {
  const surveyTotals = await getSurveyTotals(user.orgId, surveyId);
  const totalQuestions = surveyTotals.reduce((sum, survey) => sum + survey.total_questions, 0);
  const totalPoints = surveyTotals.reduce((sum, survey) => sum + survey.total_points, 0);

  const scope = scopeFor(user, { org: 'org_id', admin: 'admin_id' });
  const [studentRows] = await pool.query(
    `SELECT id, name FROM users WHERE role = 'student' AND ${scope.sql} ORDER BY name`,
    scope.params
  );

  // Restricted to the scoped students AND this org's surveys. Previously this
  // had no WHERE clause at all: it aggregated every response row in the
  // database on every call, and a student's numerator counted answers to
  // surveys outside their own organization.
  //
  // The empty guard is not theoretical -- a newly invited teacher has no
  // students yet, and mysql2 renders an empty array as `IN ()`, a syntax
  // error.
  let responsesByStudentId = new Map();
  if (studentRows.length > 0) {
    // The numerator is filtered by surveyId alongside the denominator, never
    // on its own. Narrowing only the total would leave answers to other
    // surveys counting toward the selected survey's questions and report
    // ratios above 100%.
    const responseConditions = ['s.org_id = ?', 'r.student_id IN (?)'];
    const responseParams = [user.orgId, studentRows.map((row) => row.id)];

    if (surveyId != null) {
      responseConditions.push('r.survey_id = ?');
      responseParams.push(surveyId);
    }

    const [responseRows] = await pool.query(
      `SELECT r.student_id, COUNT(DISTINCT r.question_id) AS completed_questions,
              CAST(SUM(r.points_earned) AS UNSIGNED) AS earned_points,
              MAX(r.submitted_at) AS last_submitted_at
       FROM survey_responses r
       JOIN surveys s ON s.id = r.survey_id
       WHERE ${responseConditions.join(' AND ')}
       GROUP BY r.student_id`,
      responseParams
    );
    responsesByStudentId = new Map(responseRows.map((row) => [row.student_id, row]));
  }

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
  computeAllStudentsProgress,
  getDefaultSurveyId,
  listSurveyOptions
};
