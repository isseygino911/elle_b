-- 0032_create_assignments.sql
-- The homework itself: an instruction published into a course (0030) and
-- collected back as submissions (0033).
--
-- ON THE accepts_* COLUMNS -- READ THIS BEFORE CHANGING THEM
-- These three flags look exactly like Canvas's "Online Entry Options"
-- checkboxes and mean the OPPOSITE thing. The difference is the whole reason
-- this feature was built rather than cloned.
--
-- In Canvas, ticking Text Entry and File Uploads offers the student a CHOICE:
-- their submission carries exactly one of the two, the UI presents them as
-- tabs, and switching tabs mid-attempt discards the other draft. There is no
-- way to require both, and no way to require a file without removing the text
-- box entirely.
--
-- Here they declare which PARTS one submission may carry. All three may be
-- true at once, and a student then submits prose AND attachments AND a camera
-- recording in a single act -- one submissions row plus its submission_files
-- children. A violin student writes what they found hard, attaches the marked
-- score, and records the run-through; that is one piece of homework, not three
-- competing formats.
--
-- Consequence for anyone extending this: never add a column that makes these
-- mutually exclusive, and never let the UI render them as tabs.
--
-- At least one must be true. That is enforced in the route rather than by a
-- CHECK constraint: a three-column CHECK reports as a generic constraint
-- violation, and this needs to reach the teacher as a 400 explaining which
-- combination is empty.
--
-- ON reference_url BEING A COLUMN
-- Canvas has no such field -- an instructor's reference link is typed into the
-- description prose as a hyperlink. A real column keeps the link
-- machine-readable (renderable as a proper affordance, checkable, and later
-- attachable to a preview) instead of buried in free text.
--
-- ON due_date BEING DATE, NOT DATETIME
-- Follows tasks.due_date. bookings.scheduled_at is DATETIME holding a UTC
-- wall-clock and drags the whole dateStrings/toIsoUtcString discipline with it
-- (see 0009's header for how expensive that is). Homework is due on a day, not
-- at an instant, so the cheaper type is also the more truthful one.
--
-- ON status BEING THE FAN-OUT TRIGGER
-- A teacher drafts an assignment over several sittings; nobody should be
-- notified until they say so. The draft -> published transition is what fans
-- out notifications, and the route reads the previous value under FOR UPDATE
-- so re-saving a published assignment cannot notify twice.
--
-- ENGINE NOTE: MariaDB 11.8 in production. Each statement stands alone, per
-- the convention established in 0012/0017 (batched multi-clause ALTER TABLE
-- reproduces errno 121 here).
--
-- Security: body is free text authored by a teacher and delivered to every
-- enrolled student. Same host constraint as everywhere else: ENCRYPTION='Y'
-- intentionally NOT specified (Hostinger host has no keyring plugin). See
-- migrations/README.md.

CREATE TABLE assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id BIGINT UNSIGNED NOT NULL,
  course_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  -- The instruction. NULL-able because a title plus a due date is a legitimate
  -- minimal assignment ("Scales, Friday").
  body TEXT NULL,
  -- The field Canvas lacks; see the note above. 2048 rather than 255 because
  -- real URLs with query strings routinely exceed 255.
  reference_url VARCHAR(2048) NULL,
  -- A calendar day, not an instant. See the note above.
  due_date DATE NULL,
  -- NULL means unlimited. Every attempt is kept as its own submissions row, so
  -- this bounds how many a student may create, not how many are retained.
  allowed_attempts INT UNSIGNED NULL,
  -- Which parts one submission may carry. NOT mutually exclusive -- see the
  -- long note above.
  accepts_text TINYINT(1) NOT NULL DEFAULT 1,
  accepts_files TINYINT(1) NOT NULL DEFAULT 1,
  -- Defaults OFF: recording is the newest capability and opting in should be a
  -- deliberate act by the teacher, not something every assignment inherits.
  accepts_recording TINYINT(1) NOT NULL DEFAULT 0,
  -- Seconds. Carried per-assignment so a scales exercise and a full piece can
  -- differ without a migration. Meaningless while accepts_recording = 0, but
  -- NOT NULL with a default so the route never has to special-case a missing
  -- cap when the teacher toggles recording on later.
  max_recording_sec INT UNSIGNED NOT NULL DEFAULT 300,
  status ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Serves the dashboard's "homework due" section, which sweeps an org for
  -- upcoming due dates.
  KEY idx_assignments_org_id_due_date (org_id, due_date),
  -- Serves the course detail page: this course's assignments, with a student's
  -- view filtered to status = 'published'.
  KEY idx_assignments_course_id_status (course_id, status),
  CONSTRAINT fk_assignments_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_assignments_course_id
    FOREIGN KEY (course_id) REFERENCES courses (id)
    ON DELETE CASCADE,
  -- ON DELETE RESTRICT, matching videos.uploaded_by and library_files
  -- .uploaded_by: authorship is an audit trail and must not vanish with the
  -- account row.
  CONSTRAINT fk_assignments_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS assignments;
