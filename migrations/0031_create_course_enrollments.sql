-- 0031_create_course_enrollments.sql
-- Which students are in which course. The join table between courses (0030)
-- and the student rows in users.
--
-- WHY NOT DERIVE ENROLLMENT FROM users.admin_id
-- A teacher's roster and a course's membership are different sets, and
-- conflating them would be wrong in both directions: a teacher may run two
-- courses with different students in each, and a student on the roster may not
-- be in any course at all. The roster edge answers "who teaches this student";
-- this table answers "who is doing this homework". Only the second one can be
-- fanned out to when an assignment is published.
--
-- The roster edge is still load-bearing at WRITE time: the route calls
-- assertStudentInScope() before inserting, so a teacher can only ever enroll a
-- student who is already theirs. This table records the result of that check,
-- it does not replace it.
--
-- ON THE UNIQUE KEY
-- (course_id, student_id) is unique so a double-enroll is a duplicate-key
-- error the route turns into a 409, rather than a SELECT-then-INSERT race that
-- silently produces two rows and then fans out to the same student twice. Same
-- reasoning as uq_library_files_s3_key in 0015.
--
-- ENGINE NOTE: MariaDB 11.8 in production. Each statement stands alone, per
-- the convention established in 0012/0017 (batched multi-clause ALTER TABLE
-- reproduces errno 121 here).
--
-- Security: this table is a membership list -- it names which students are in
-- a course, so it is per-student data and never reachable by a manager. Same
-- host constraint as everywhere else: ENCRYPTION='Y' intentionally NOT
-- specified (Hostinger host has no keyring plugin). See migrations/README.md.

CREATE TABLE course_enrollments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Denormalised from courses.org_id so every query on this table can be
  -- org-fenced without a join, matching how 0023/0024 pushed org_id onto every
  -- content table rather than reaching it through a parent.
  org_id BIGINT UNSIGNED NOT NULL,
  course_id BIGINT UNSIGNED NOT NULL,
  student_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The write guard described above, and the reason a double-enroll is a 409.
  UNIQUE KEY uq_course_enrollments_course_id_student_id (course_id, student_id),
  -- Serves the fan-out on publish: every student in this course.
  KEY idx_course_enrollments_course_id (course_id),
  -- Serves the student's own "which courses am I in" list.
  KEY idx_course_enrollments_student_id (student_id),
  KEY idx_course_enrollments_org_id_created_at (org_id, created_at),
  CONSTRAINT fk_course_enrollments_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE CASCADE,
  -- ON DELETE CASCADE on both edges, unlike courses.admin_id: an enrollment is
  -- pure membership, carrying no authored content of its own. With either the
  -- course or the student gone there is nothing left for the row to assert.
  -- The student's SUBMISSIONS are not affected -- those hang off assignments,
  -- not off this table.
  CONSTRAINT fk_course_enrollments_course_id
    FOREIGN KEY (course_id) REFERENCES courses (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_course_enrollments_student_id
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS course_enrollments;
