-- 0030_create_courses.sql
-- The container a teacher groups homework into. First entity in the
-- courses -> assignments -> submissions chain added by 0030-0034.
--
-- WHY A COURSE ENTITY AT ALL, in a studio that teaches one-to-one:
--
-- docs/research/canvas-vs-elle-feature-comparison.md calls the absence of a
-- course "the single biggest structural difference" between Elle and Canvas.
-- The alternative considered was hanging assignments straight off the
-- users.admin_id roster edge, which is cheaper and gets per-student isolation
-- for free. It was rejected because homework needs a NAME to be grouped under
-- -- "Grade 3 Repertoire", "Summer Scales" -- and a roster edge cannot carry
-- one. Without it every assignment a teacher ever set would live in a single
-- flat list per student.
--
-- ON admin_id BEING RESTRICT WHERE MOST FKs HERE ARE CASCADE
-- A course is authored work with student submissions hanging off it. Deleting
-- the teacher row must not silently delete the homework history of every
-- student they taught -- that history is the students' record as much as the
-- teacher's. RESTRICT forces the caller to deal with the courses first, which
-- matches how videos.uploaded_by and library_files.uploaded_by already treat
-- authorship (0023/0024). org_id stays CASCADE, consistent with every
-- org-scoped table since 0021: deleting an organization does remove its data.
--
-- ON status BEING AN ENUM RATHER THAN A DELETE
-- A finished term's course still owns its assignments and submissions, so it
-- is archived rather than removed. 'archived' hides it from the default list
-- without touching a single child row.
--
-- ENGINE NOTE: MariaDB 11.8 in production. Each statement stands alone, per
-- the convention established in 0012/0017 (batched multi-clause ALTER TABLE
-- reproduces errno 121 here).
--
-- Security: title and description are free text authored by a teacher and
-- shown to enrolled students. Same host constraint as everywhere else:
-- ENCRYPTION='Y' intentionally NOT specified (Hostinger host has no keyring
-- plugin). See migrations/README.md.

CREATE TABLE courses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id BIGINT UNSIGNED NOT NULL,
  -- The owning teacher. This is the column scopeFor() fences on for the ADMIN
  -- branch, so it is what stops one teacher reading another's course. NOT
  -- NULL: an ownerless course would fall out of that fence entirely and become
  -- visible org-wide, which is the exact failure the branch exists to prevent.
  admin_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  status ENUM('active', 'archived') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Serves the owner's org-wide list, newest-first.
  KEY idx_courses_org_id_created_at (org_id, created_at),
  -- Serves the teacher's own list, which filters on status to hide archived
  -- courses by default.
  KEY idx_courses_admin_id_status (admin_id, status),
  CONSTRAINT fk_courses_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE CASCADE,
  -- ON DELETE RESTRICT: see the note above. Authored work outlives the
  -- author's account row.
  CONSTRAINT fk_courses_admin_id
    FOREIGN KEY (admin_id) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS courses;
