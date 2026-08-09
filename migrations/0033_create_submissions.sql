-- 0033_create_submissions.sql
-- What the student hands back, and the files attached to it. Two tables in one
-- migration because submission_files has no meaning apart from submissions --
-- they are one logical change (migrations/README.md).
--
-- THE PARENT/CHILD SPLIT IS THE FEATURE
-- One submissions row holds the prose; zero or more submission_files rows hold
-- the attachments and the camera recording. That shape is what lets a single
-- submission carry text AND files AND a recording together -- see 0032's note
-- on the accepts_* columns for why Canvas structurally cannot express this and
-- why we are not copying it. Collapsing the files back into columns on
-- submissions would cap attachments at whatever number was guessed here.
--
-- ON attempt AND WHY EVERY ATTEMPT IS KEPT
-- A resubmission is a new row, not an UPDATE. For instrument practice the
-- progression between takes is itself the interesting record -- a teacher
-- comparing attempt 1 with attempt 3 is looking at exactly what improved. The
-- alternative (one row per student per assignment, overwritten) is cheaper but
-- destroys that.
--
-- (assignment_id, student_id, attempt) is UNIQUE so two concurrent submits
-- collide on the key instead of both reading MAX(attempt) = 1 and both writing
-- attempt 2. The route computes the next attempt under FOR UPDATE; this key is
-- the backstop for when that discipline is bypassed.
--
-- ON THE reviewed LOCK
-- status goes 'submitted' -> 'reviewed' and the route refuses a student edit
-- once it reads 'reviewed'. Without that, a teacher's feedback can end up
-- attached to work that has since changed underneath it -- the comment says
-- "watch bar 14" and bar 14 is now different. The lock lives in the route, not
-- in a trigger, but the column is what it reads.
--
-- ENGINE NOTE: MariaDB 11.8 in production. Each statement stands alone, per
-- the convention established in 0012/0017 (batched multi-clause ALTER TABLE
-- reproduces errno 121 here).
--
-- Security: body and feedback are free text, and submission_files points at
-- student-authored media in S3. This is per-student data in the strictest
-- sense -- a manager must never reach it, and one student must never reach
-- another's. Same host constraint as everywhere else: ENCRYPTION='Y'
-- intentionally NOT specified (Hostinger host has no keyring plugin). See
-- migrations/README.md.

CREATE TABLE submissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id BIGINT UNSIGNED NOT NULL,
  assignment_id BIGINT UNSIGNED NOT NULL,
  -- The column scopeFor() fences on for the STUDENT branch. It is what stops
  -- one student reading another's work.
  student_id BIGINT UNSIGNED NOT NULL,
  -- 1-based. See the note above.
  attempt INT UNSIGNED NOT NULL,
  -- The written part. NULL-able: a submission may legitimately be a recording
  -- with nothing typed. The route rejects a submission that is empty in EVERY
  -- part, which is a different condition and cannot be expressed here.
  body TEXT NULL,
  status ENUM('submitted', 'reviewed') NOT NULL DEFAULT 'submitted',
  -- The teacher's response. Deliberately a plain column rather than a thread:
  -- videos already have comments.route.js for back-and-forth, and homework
  -- feedback in a studio is one considered reply, not a conversation.
  feedback TEXT NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The concurrency backstop described above.
  UNIQUE KEY uq_submissions_assignment_id_student_id_attempt
    (assignment_id, student_id, attempt),
  -- Serves the teacher's review queue for one assignment, and the
  -- status filter that finds what still needs looking at.
  KEY idx_submissions_assignment_id_status (assignment_id, status),
  -- Serves a student's own history across assignments.
  KEY idx_submissions_student_id_created_at (student_id, created_at),
  KEY idx_submissions_org_id_created_at (org_id, created_at),
  CONSTRAINT fk_submissions_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_submissions_assignment_id
    FOREIGN KEY (assignment_id) REFERENCES assignments (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_submissions_student_id
    FOREIGN KEY (student_id) REFERENCES users (id)
    ON DELETE CASCADE,
  -- ON DELETE SET NULL, matching notifications.actor_id: the review itself
  -- survives the reviewer's account being removed, unattributed but intact.
  -- The student's feedback text is theirs to keep.
  CONSTRAINT fk_submissions_reviewed_by
    FOREIGN KEY (reviewed_by) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE submission_files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id BIGINT UNSIGNED NOT NULL,
  submission_id BIGINT UNSIGNED NOT NULL,
  -- A camera take and an attached file are stored identically but are not the
  -- same thing: they differ in provenance, in how the UI renders them (a
  -- recording gets a player, an attachment a download link), and in what the
  -- route validates -- a recording must be video/webm and within the
  -- assignment's max_recording_sec.
  kind ENUM('attachment', 'recording') NOT NULL DEFAULT 'attachment',
  original_filename VARCHAR(255) NOT NULL,
  s3_key VARCHAR(512) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  -- Recordings only; NULL for attachments and for takes shorter than a second.
  --
  -- That second case is not an oversight. A MediaRecorder WebM carries no
  -- duration in its header -- a <video> element reports Infinity for it -- so
  -- useMediaRecorder counts wall-clock seconds instead and returns
  -- `secondsRef.current || null`, which is null rather than 0 for a sub-second
  -- take. The column has to tolerate that; defaulting it to 0 would record a
  -- measurement that was never made.
  duration_sec INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Makes a replayed confirm a duplicate-key error the route turns into a 409,
  -- rather than a second row pointing at the same object. Same role as
  -- uq_library_files_s3_key in 0015 and uq_videos_s3_key in 0003.
  UNIQUE KEY uq_submission_files_s3_key (s3_key),
  KEY idx_submission_files_submission_id (submission_id),
  KEY idx_submission_files_org_id_created_at (org_id, created_at),
  CONSTRAINT fk_submission_files_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_submission_files_submission_id
    FOREIGN KEY (submission_id) REFERENCES submissions (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS submission_files;
-- DROP TABLE IF EXISTS submissions;
