-- 0012_survey_responses_per_student.sql
-- Redesigns survey assignment from "one survey = one assigned student" to
-- "one survey = visible to every student, each student takes it
-- independently with their own progress". This replaces the per-assignment
-- model introduced in 0002_create_surveys.sql and the "one response ever,
-- globally, per question" locking model introduced in
-- 0011_create_survey_responses.sql.
--
-- Design notes:
--   - surveys.student_id (and its index/FK) is dropped entirely rather than
--     left as an always-NULL vestigial column. Under the new model a survey
--     is never assigned to a single student -- every survey is visible to
--     every student -- so the column has no remaining purpose, its index
--     (idx_surveys_student_id_uploaded_at) has no query pattern left to
--     serve, and its FK (fk_surveys_student_id) constrains a value that no
--     longer exists. Keeping an unused, always-NULL column around would
--     violate this project's "remove unused code as you go" convention
--     (e.g. the FK/index cleanups already done in earlier phases) -- so it
--     is removed outright rather than merely stopped-from-being-written-to.
--   - survey_responses.student_id changes from nullable to NOT NULL. Under
--     the old model, student_id was an optional attribution on an
--     already-uniquely-identified-by-question_id row (nullable, ON DELETE
--     SET NULL, "outlive a deleted student as a historical record" -- see
--     0011). Under the new model, a response's identity is fundamentally
--     the (question, student) pair -- there is no such thing as a
--     studentless response anymore, since every student answers every
--     question independently. NOT NULL is safe here because the table is
--     confirmed empty (0 rows) in production.
--   - fk_survey_responses_student_id is dropped and re-added with ON DELETE
--     CASCADE (was ON DELETE SET NULL). SET NULL is no longer legal once the
--     column is NOT NULL, but more importantly it's no longer the right
--     semantics: because student_id is now part of this row's core
--     identity (not an optional attribution the way surveys.student_id
--     historically was), a response has no meaning once its student is
--     gone, so it should be deleted along with the student -- the same
--     "no purpose once its owning entity is gone" reasoning already used
--     for this table's survey_id/question_id/answer_id FKs in 0011.
--   - uq_survey_responses_question_id (question_id) is dropped and replaced
--     with uq_survey_responses_question_id_student_id (question_id,
--     student_id). The old unique key was the entire lock mechanism under
--     the "one survey, one assigned student" assumption: at most one
--     response could ever exist per question, full stop, because only one
--     student would ever be answering it. That assumption is gone -- many
--     different students now each need their own independent response to
--     the same question. The new composite unique key preserves the
--     "locked after submission" behavior (the submit endpoint's INSERT
--     still fails on a duplicate, which the application layer still turns
--     into a friendly "already submitted" error) but scopes the lock to
--     (question, student): each student can submit each question exactly
--     once, independently of every other student. This composite key's
--     leftmost column (question_id) continues to satisfy InnoDB's
--     FK-indexing requirement for fk_survey_responses_question_id, same as
--     before.
--   - idx_survey_responses_survey_id_student_id,
--     idx_survey_responses_student_id, and idx_survey_responses_answer_id
--     (all from 0011) are unaffected by this migration -- their query
--     patterns and FK-indexing justifications are unchanged by this
--     redesign, so they are left as-is.
--
-- Statement grouping note: this project's production host
-- (Hostinger-managed database) runs MariaDB 11.8, not MySQL -- confirmed via
-- SELECT VERSION() while applying this migration. Dropping
-- fk_survey_responses_student_id in the SAME ALTER TABLE statement as the
-- index drop/add + column MODIFY + same-named FK re-add reproducibly fails
-- there with errno 121 ("Duplicate key on write or update") even though the
-- table is empty and the resulting schema is valid -- an observed MariaDB
-- ALTER-planning limitation when that particular combination of clauses is
-- batched together, not a logic error in the DDL itself. The FK drop is
-- therefore issued as its own ALTER TABLE statement, separate from the
-- index/column/FK-re-add statement that follows it; both forms were verified
-- individually against the live database.

-- surveys: drop the no-longer-meaningful per-student assignment column,
-- its FK, and its now-purposeless index.
ALTER TABLE surveys
  DROP FOREIGN KEY fk_surveys_student_id,
  DROP INDEX idx_surveys_student_id_uploaded_at,
  DROP COLUMN student_id;

-- survey_responses: drop the old per-student FK first, as its own statement
-- (see "Statement grouping note" above).
ALTER TABLE survey_responses
  DROP FOREIGN KEY fk_survey_responses_student_id;

-- survey_responses: re-scope the submission lock from "per question" to
-- "per question per student", and make student_id a required part of a
-- response's identity (NOT NULL, ON DELETE CASCADE) rather than an optional,
-- outlives-the-student attribution.
ALTER TABLE survey_responses
  DROP INDEX uq_survey_responses_question_id,
  MODIFY COLUMN student_id BIGINT UNSIGNED NOT NULL,
  ADD UNIQUE KEY uq_survey_responses_question_id_student_id (question_id, student_id),
  ADD CONSTRAINT fk_survey_responses_student_id
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE CASCADE;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE survey_responses
--   DROP FOREIGN KEY fk_survey_responses_student_id,
--   DROP INDEX uq_survey_responses_question_id_student_id,
--   MODIFY COLUMN student_id BIGINT UNSIGNED NULL,
--   ADD UNIQUE KEY uq_survey_responses_question_id (question_id),
--   ADD CONSTRAINT fk_survey_responses_student_id
--     FOREIGN KEY (student_id) REFERENCES users (id)
--     ON DELETE SET NULL;
--
-- ALTER TABLE surveys
--   ADD COLUMN student_id BIGINT UNSIGNED NULL,
--   ADD KEY idx_surveys_student_id_uploaded_at (student_id, uploaded_at),
--   ADD CONSTRAINT fk_surveys_student_id
--     FOREIGN KEY (student_id) REFERENCES users (id)
--     ON DELETE SET NULL;
