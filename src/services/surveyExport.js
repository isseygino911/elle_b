// Renders one student's filled-in survey as a standalone, printable HTML
// document. No Express/DB/S3 imports here — this module only turns already
// loaded rows into a string, the same separation surveyXmlParser.js keeps on
// the way in.
//
// WHY HTML AND NOT CSV/PDF
// The document has to look like the survey does on screen: every statement
// followed by its 1..N scale drawn as circled numbers, with the number the
// student actually chose filled in. A CSV can only put a value in a cell —
// it cannot draw a scale, so the "which numbers were on offer, and which one
// did they pick" reading is lost. A real PDF would need a new dependency
// (pdfkit); HTML needs none, and the teacher still gets a PDF out of it via
// the browser's Print → Save as PDF. The stylesheet is inlined and there are
// no external references, so the file is self-contained once downloaded.
//
// It is deliberately NOT a React render of SurveyDetailPage. That component
// is interactive (tabs, radio inputs, submit handlers) and lives in the
// client bundle; this is a flat print layout of the same information, which
// is a different enough artifact that sharing code would mean making the
// page render-agnostic for no benefit to either side.

// Mirrors the client's localize() in SurveyDetailPage.jsx: survey content is
// per-survey user data from the uploaded XML, so each text column has a _zh
// sibling (migration 0013) that falls back to English when a translation
// hasn't been entered for that row.
function localize(en, zh, language) {
  return language === 'zh' && zh ? zh : en;
}

// The five characters that can change the meaning of surrounding markup.
// Survey text is author-supplied and student names come from the users
// table, so every interpolated value goes through this — the document is
// opened in a browser, which makes an unescaped `<` a script-injection
// vector, not merely a rendering bug.
const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

// The UI draws each statement's scale as a row of numbered circles and fills
// the chosen one (SurveyDetailPage.jsx's RatingScale). This reproduces that
// in print: every number 1..max is rendered, and the selected one gets the
// lime fill, so the reader sees the range that was on offer as well as the
// answer. `selected` is null for a day the student never submitted — the
// scale still prints, entirely unfilled, which is what makes an unanswered
// day visibly unanswered rather than absent.
//
// Above SCALE_PRINT_LIMIT the circles would wrap into an unreadable block on
// paper, so the scale degrades to a plain "8 / 100" reading. The parser
// allows points up to 1000; 10 is the norm in practice. This mirrors the
// client's own SCALE_BUTTON_LIMIT fallback to a <select> for the same reason.
const SCALE_PRINT_LIMIT = 12;

function renderScale(max, selected) {
  if (max > SCALE_PRINT_LIMIT) {
    const shown = selected === null ? '—' : escapeHtml(selected);
    return `<p class="scale-wide">${shown} / ${escapeHtml(max)}</p>`;
  }

  const circles = [];
  for (let n = 1; n <= max; n += 1) {
    const className = n === selected ? 'circle circle-filled' : 'circle';
    circles.push(`<span class="${className}">${n}</span>`);
  }

  return `<p class="scale">${circles.join('')}</p>`;
}

// One rateable statement: the full question (the day's prompt joined to the
// statement, which is how the student actually read it — see
// surveyXmlParser.js on the prefix/statement split) followed by its scale.
function renderStatement(prompt, answer, rating, language) {
  const statement = localize(answer.answer_text, answer.answer_text_zh, language);
  const category = answer.category
    ? `<span class="category">${escapeHtml(answer.category)}</span>`
    : '';
  const score =
    rating === null
      ? '<span class="score score-empty">Not answered</span>'
      : `<span class="score">${escapeHtml(rating)} / ${escapeHtml(answer.points)}</span>`;

  return `
        <li class="statement">
          <div class="statement-head">
            <span class="question">${escapeHtml(prompt)} ${escapeHtml(statement)}</span>
            ${score}
          </div>
          ${category}
          ${renderScale(answer.points, rating)}
        </li>`;
}

// One day: its prompt as a section header, then every statement in it. Days
// are numbered by their position among answerable questions, matching the
// "Day 1, Day 2, ..." tabs the UI labels them with (the XML carries no day
// number of its own).
function renderDay(question, dayNumber, ratingsByAnswerId, language) {
  const prompt = localize(question.question_text, question.question_text_zh, language);
  const statements = question.answers
    .map((answer) =>
      renderStatement(prompt, answer, ratingsByAnswerId.get(answer.id) ?? null, language)
    )
    .join('');

  const earned = question.answers.reduce(
    (sum, answer) => sum + (ratingsByAnswerId.get(answer.id) ?? 0),
    0
  );
  // A day counts as answered only when every statement carries a rating —
  // the same completeness rule attachSubmissions() applies in
  // surveys.route.js, so a half-written day reads as unanswered here too
  // rather than reporting a misleadingly low total.
  const isAnswered = question.answers.every((answer) => ratingsByAnswerId.has(answer.id));

  const total = isAnswered
    ? `<p class="day-total">Day total: <strong>${escapeHtml(earned)} / ${escapeHtml(question.points)}</strong></p>`
    : '<p class="day-total day-total-empty">Not yet submitted</p>';

  return `
      <section class="day">
        <h2 class="day-title">Day ${dayNumber} — ${escapeHtml(prompt)}</h2>
        <ol class="statements">${statements}</ol>
        ${total}
      </section>`;
}

// "Flat" questions (no <answer> children) are never rated — they get no
// survey_responses row at all (see migration 0011) and the client excludes
// them from scoring. They still belong in a faithful copy of the survey, so
// they print as a plain list with their point value and no scale.
function renderFlatQuestions(questions, language) {
  if (questions.length === 0) {
    return '';
  }

  const items = questions
    .map(
      (question) => `
          <li class="flat-question">
            <span>${escapeHtml(localize(question.question_text, question.question_text_zh, language))}</span>
            <span class="score">${escapeHtml(question.points)} pts</span>
          </li>`
    )
    .join('');

  return `
      <section class="day">
        <h2 class="day-title">Additional questions</h2>
        <ul class="statements">${items}</ul>
      </section>`;
}

// Colours are copied from the client's tokens.css rather than imported —
// this document is served standalone with no access to the app's stylesheet,
// and it must keep rendering as the survey did even if the app is later
// rethemed (a saved export is a record of what the student saw).
const STYLES = `
    :root { --lime: #c6e83a; --on-lime: #1a2100; --border: #e4e4e7; --muted: #6b7280; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 32px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #18181b; line-height: 1.5;
    }
    .sheet { max-width: 820px; margin: 0 auto; }
    header { border-bottom: 2px solid var(--lime); padding-bottom: 16px; margin-bottom: 8px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .meta { margin: 2px 0; font-size: 13px; color: var(--muted); }
    .summary {
      display: flex; gap: 24px; flex-wrap: wrap;
      background: var(--lime); color: var(--on-lime);
      padding: 12px 16px; border-radius: 12px; margin: 16px 0 24px;
      font-size: 14px; font-weight: 600;
    }
    .day { margin-bottom: 28px; break-inside: avoid; }
    .day-title {
      font-size: 15px; margin: 0 0 12px; padding: 8px 12px;
      background: var(--lime); color: var(--on-lime); border-radius: 8px;
    }
    .statements { list-style: none; margin: 0; padding: 0; }
    .statement, .flat-question {
      padding: 10px 0; border-bottom: 1px solid var(--border); break-inside: avoid;
    }
    .statement:last-child, .flat-question:last-child { border-bottom: none; }
    .flat-question { display: flex; justify-content: space-between; gap: 16px; }
    .statement-head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
    .question { font-size: 14px; }
    .score { font-size: 13px; font-weight: 700; white-space: nowrap; }
    .score-empty { font-weight: 400; color: var(--muted); font-style: italic; }
    .category { display: inline-block; font-size: 11px; color: var(--muted); margin-top: 2px; }
    .scale { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
    .circle {
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border-radius: 50%;
      border: 1px solid var(--border); color: var(--muted);
      font-size: 12px; font-variant-numeric: tabular-nums;
    }
    .circle-filled {
      background: var(--lime); color: var(--on-lime);
      border-color: transparent; font-weight: 700;
    }
    .scale-wide { margin: 8px 0 0; font-size: 13px; font-weight: 700; }
    .day-total { margin: 12px 0 0; font-size: 13px; }
    .day-total-empty { color: var(--muted); font-style: italic; }
    footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--border);
             font-size: 11px; color: var(--muted); }
    /* Keep the lime fills when printing — browsers drop backgrounds by
       default, which would erase the one mark that carries the answer. */
    @media print {
      body { padding: 0; }
      .summary, .day-title, .circle-filled { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }`;

// Builds the whole document.
//
// `questions` is loadQuestionsWithAnswers()'s output (each with `answers`),
// and `responsesByQuestionId` is loadResponsesByQuestionId()'s — the same two
// shapes GET /surveys/:id already assembles, so the export reports exactly
// what that page would show for this student.
function renderSurveyExportHtml({ survey, student, questions, responsesByQuestionId, language = 'en', exportedAt }) {
  const answerable = questions.filter((question) => question.answers.length > 0);
  const flat = questions.filter((question) => question.answers.length === 0);

  // points_earned is the student's actual 1..N rating for that statement,
  // NOT a copy of survey_answers.points — see migration 0014, which changed
  // the column's meaning. Keyed by answer_id so each statement finds its own.
  const ratingsByAnswerId = new Map();
  for (const rows of responsesByQuestionId.values()) {
    for (const row of rows) {
      ratingsByAnswerId.set(row.answer_id, row.points_earned);
    }
  }

  const days = answerable
    .map((question, index) => renderDay(question, index + 1, ratingsByAnswerId, language))
    .join('');

  const completedDays = answerable.filter((question) =>
    question.answers.every((answer) => ratingsByAnswerId.has(answer.id))
  ).length;
  const earnedPoints = answerable.reduce(
    (sum, question) =>
      sum +
      question.answers.reduce((daySum, answer) => daySum + (ratingsByAnswerId.get(answer.id) ?? 0), 0),
    0
  );
  const totalPoints = answerable.reduce((sum, question) => sum + question.points, 0);

  const title = localize(survey.title, survey.title_zh, language);

  return `<!doctype html>
<html lang="${language === 'zh' ? 'zh' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(student.name)}</title>
<style>${STYLES}
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">Student: <strong>${escapeHtml(student.name)}</strong>${student.email ? ` (${escapeHtml(student.email)})` : ''}</p>
      <p class="meta">Source file: ${escapeHtml(survey.original_filename)} — uploaded ${escapeHtml(survey.uploaded_at)}</p>
      <p class="meta">Exported: ${escapeHtml(exportedAt)}</p>
    </header>

    <div class="summary">
      <span>${escapeHtml(completedDays)} of ${escapeHtml(answerable.length)} days completed</span>
      <span>${escapeHtml(earnedPoints)} / ${escapeHtml(totalPoints)} points</span>
    </div>
${days}${renderFlatQuestions(flat, language)}
    <footer>Generated from submitted survey responses. A filled circle marks the rating the student gave.</footer>
  </div>
</body>
</html>`;
}

module.exports = { renderSurveyExportHtml };
