-- 0013_add_survey_zh_translations.sql
-- Adds optional Chinese-language fields alongside the existing English
-- content, so a survey's title/questions/answers can be shown in either
-- language via the app's existing EN/ZH toggle (client/src/lib/
-- LanguageContext.jsx). This is content translation, not UI-chrome i18n --
-- that toggle already covers static strings via translations.js; this
-- migration is what lets the *same* toggle also switch survey content.
--
-- Design notes:
--   - All three new columns are nullable and additive-only: existing rows
--     (and any survey uploaded without a translation) simply have NULL
--     here, and the app falls back to the English column when the ZH one
--     is empty. No existing column changes meaning or nullability.
--   - surveys.title_zh: VARCHAR(255) NULL, matching surveys.title's own
--     type exactly (0002_create_surveys.sql).
--   - survey_questions.question_text_zh: TEXT NULL, matching
--     survey_questions.question_text's type exactly (0002).
--   - survey_answers.answer_text_zh: TEXT NULL, matching
--     survey_answers.answer_text's type exactly (0010).
--   - No new indexes: none of these columns are queried or filtered on --
--     they're only ever selected alongside their English counterpart and
--     picked between in the application layer.
--
-- Security: same posture as the English counterparts these columns sit
-- next to (surveys/survey_questions/survey_answers already hold
-- student-adjacent free text with ENCRYPTION='Y' intentionally not
-- specified -- see 0002/0010) -- no change in sensitivity class introduced
-- here.

ALTER TABLE surveys
  ADD COLUMN title_zh VARCHAR(255) NULL AFTER title;

ALTER TABLE survey_questions
  ADD COLUMN question_text_zh TEXT NULL AFTER question_text;

ALTER TABLE survey_answers
  ADD COLUMN answer_text_zh TEXT NULL AFTER answer_text;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE survey_answers DROP COLUMN answer_text_zh;
-- ALTER TABLE survey_questions DROP COLUMN question_text_zh;
-- ALTER TABLE surveys DROP COLUMN title_zh;
