-- 0010_create_survey_answers.sql
-- Adds support for questions that carry their own set of scored answer
-- choices (e.g. a reflection-survey day: one prompt, several scoring items
-- each optionally tagged with a category). Additive only -- existing flat
-- "question is itself the single scored item, no answers" surveys are
-- untouched and remain valid; survey_questions.points keeps its original
-- meaning for that case, and becomes the SUM of its answers' points when
-- answers exist (computed by the app in surveyXmlParser.js at parse time,
-- not by the DB).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0009.
--   - question_id: NOT NULL FK -> survey_questions.id. ON DELETE CASCADE:
--     an answer has no purpose once its question is gone, same reasoning
--     as survey_questions.survey_id -> surveys.id in 0002.
--   - order_index: SMALLINT UNSIGNED NOT NULL, preserves the answer's
--     position within its question exactly as survey_questions.order_index
--     does within its survey.
--   - answer_text: TEXT NOT NULL, matching survey_questions.question_text's
--     type (free text, length validated at the application layer by
--     surveyXmlParser.js, not the DB).
--   - points: SMALLINT UNSIGNED NOT NULL, matching survey_questions.points
--     exactly (same 0-1000 application-level range).
--   - category: VARCHAR(100) NULL -- an optional free-text tag on an
--     individual answer (e.g. "Music" / "Psychology" in the reflection-
--     survey use case). Nullable because not every survey categorizes its
--     answers; NOT an ENUM because category values are survey-author-
--     defined per upload, not a fixed app-wide set.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     every other table.
--
-- Security: holds no free text beyond survey-author-supplied XML content,
-- same posture as survey_questions in 0002 -- ENCRYPTION='Y' intentionally
-- NOT specified. See server/migrations/README.md.
--
-- Indexing:
--   - idx_survey_answers_question_id_order_index (question_id, order_index):
--     serves "list this question's answers in order" and satisfies InnoDB's
--     FK-indexing requirement for fk_survey_answers_question_id via its
--     leftmost column.

CREATE TABLE survey_answers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  question_id BIGINT UNSIGNED NOT NULL,
  order_index SMALLINT UNSIGNED NOT NULL,
  answer_text TEXT NOT NULL,
  points SMALLINT UNSIGNED NOT NULL,
  category VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_survey_answers_question_id_order_index (question_id, order_index),
  CONSTRAINT fk_survey_answers_question_id
    FOREIGN KEY (question_id) REFERENCES survey_questions (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS survey_answers;
