-- 0011_create_survey_responses.sql
-- Adds support for a student actually taking a survey day-by-day: each
-- question (day) that has answer choices becomes a single-select submission
-- recorded here. Questions with zero rows in survey_answers ("flat"
-- questions, the question itself is the single scored item) are not part of
-- this flow and never get a survey_responses row.
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0010.
--   - survey_id: NOT NULL FK -> surveys.id. ON DELETE CASCADE, matching
--     survey_questions.survey_id's exact rationale from 0002: a response has
--     no purpose once its survey is gone. Denormalized alongside
--     question_id (technically derivable via survey_questions.survey_id)
--     purely so "all of this student's responses for survey X" can be
--     queried without a join -- same pragmatic denormalization spirit as
--     points_earned below and as this project's other tables.
--   - question_id: NOT NULL FK -> survey_questions.id. ON DELETE CASCADE,
--     matching survey_answers.question_id's exact rationale from 0010: a
--     response has no purpose once its question is gone. This is the "day"
--     being answered.
--   - student_id: nullable FK -> users.id. ON DELETE SET NULL, matching
--     surveys.student_id's exact rationale from 0002: a response record
--     should outlive a deleted student as a historical record, not
--     disappear with them.
--   - answer_id: NOT NULL FK -> survey_answers.id. ON DELETE CASCADE -- the
--     one answer choice the student selected. No delete endpoint exists for
--     answers today, but if survey content is ever removed, its responses
--     should go with it rather than orphan.
--   - points_earned: SMALLINT UNSIGNED NOT NULL, a deliberate denormalized
--     copy of survey_answers.points at submission time (not just derived
--     via join), so a response's recorded score is immutable even if survey
--     content were ever edited later. Same SMALLINT UNSIGNED type as
--     survey_answers.points, since it's a direct copy of that value.
--   - submitted_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     the created_at/uploaded_at pattern used elsewhere, named submitted_at
--     here because it specifically marks the submission event.
--
-- Security: holds no free text of its own beyond ids, a score, and a
-- timestamp -- same posture as survey_answers in 0010 -- ENCRYPTION='Y'
-- intentionally NOT specified. See server/migrations/README.md.
--
-- Indexing:
--   - uq_survey_responses_question_id (question_id): the actual lock
--     mechanism -- since a survey is assigned to at most one student, at
--     most one response can ever exist per question, full stop. This is
--     what makes a day "locked after submission": the submit endpoint's
--     INSERT will fail on a duplicate, which the application layer turns
--     into a friendly "already submitted" error rather than silently
--     overwriting. This UNIQUE index also satisfies InnoDB's FK-indexing
--     requirement for fk_survey_responses_question_id.
--   - idx_survey_responses_survey_id_student_id (survey_id, student_id):
--     serves "all of this student's responses for survey X, in one query"
--     (used both by the ordering/locking check and by the survey detail
--     view for elle/student alike), and satisfies InnoDB's FK-indexing
--     requirement for fk_survey_responses_survey_id via its leftmost
--     column.
--   - idx_survey_responses_student_id (student_id): student_id is the
--     SECOND column of the composite index above, not its leftmost column,
--     so it does not satisfy InnoDB's FK-indexing requirement for
--     fk_survey_responses_student_id -- same reasoning as 0004's
--     idx_comments_author_id. Added purely for that requirement, not a new
--     query pattern.
--   - idx_survey_responses_answer_id (answer_id): not the leftmost column of
--     any other index on this table, so it needs its own explicit index to
--     satisfy InnoDB's requirement that fk_survey_responses_answer_id's
--     column be indexed -- same pattern as above.
--   None of these indexes is speculative -- each maps directly to either a
--   stated query pattern or an InnoDB foreign-key indexing requirement.

CREATE TABLE survey_responses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  survey_id BIGINT UNSIGNED NOT NULL,
  question_id BIGINT UNSIGNED NOT NULL,
  student_id BIGINT UNSIGNED NULL,
  answer_id BIGINT UNSIGNED NOT NULL,
  points_earned SMALLINT UNSIGNED NOT NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_survey_responses_question_id (question_id),
  KEY idx_survey_responses_survey_id_student_id (survey_id, student_id),
  KEY idx_survey_responses_student_id (student_id),
  KEY idx_survey_responses_answer_id (answer_id),
  CONSTRAINT fk_survey_responses_survey_id
    FOREIGN KEY (survey_id) REFERENCES surveys (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_survey_responses_question_id
    FOREIGN KEY (question_id) REFERENCES survey_questions (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_survey_responses_student_id
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_survey_responses_answer_id
    FOREIGN KEY (answer_id) REFERENCES survey_answers (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS survey_responses;
