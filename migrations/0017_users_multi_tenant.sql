-- 0017_users_multi_tenant.sql
-- Converts `users` from a single-tenant table (one 'elle' + N students) into
-- the multi-tenant hierarchy owner > manager > admin > student.
--
-- THE ROLE MODEL (read this before touching any authorization code):
--   owner   (rank 4) -- one per organization. Sees everything in their org.
--   manager (rank 3) -- AGGREGATES ONLY. Per-admin rollups. Must NEVER read
--                       an individual student's surveys, videos or messages.
--   admin   (rank 2) -- a teacher. Sees only their own students. This is the
--                       old 'elle' role, renamed.
--   student (rank 1) -- sees only themselves.
--
-- Note the deliberate inversion: `manager` OUTRANKS `admin` for
-- administrative ordering, but sees STRICTLY LESS per-student data. Rank
-- therefore expresses ordering only, never capability inheritance -- a
-- "rank >= admin" gate would hand every manager the entire per-student
-- surface, which is exactly the privacy boundary this hierarchy exists to
-- enforce. Per-student access is gated by a positive allowlist in
-- src/constants/roles.js, not by rank. (The role formerly discussed as
-- "superadmin" was renamed to `manager` precisely because "superadmin"
-- universally implies most-privileged and would invite that wrong check.)
--
-- ENGINE NOTE: MariaDB 11.8 in production. Every ALTER below is its own
-- statement (0012 documents a reproducible errno 121 on batched
-- multi-clause ALTER TABLE here), and the generated column uses PERSISTENT
-- rather than MySQL's STORED. See migrations/README.md.
--
-- LIVE DATA: this table holds real accounts. Every column is added nullable,
-- backfilled, then tightened to NOT NULL -- a direct `ADD COLUMN ... NOT NULL`
-- with no default would either fail outright or silently zero-fill depending
-- on sql_mode. There is no DELETE anywhere in this file.
--
-- Design notes:
--   - role ENUM gains 'owner','manager','admin' and DELIBERATELY KEEPS
--     'elle' through this migration. The elle->admin rename happens as a
--     data UPDATE below; 'elle' is only removed from the ENUM in a later
--     migration (0022), after the application no longer emits it. Dropping
--     it here would mean any still-running old app process writing
--     role='elle' mid-deploy gets a hard error, making this file
--     deploy-order-dependent for no benefit.
--   - org_id: every user belongs to exactly one organization. Backfilled to
--     org 1 (created in 0016), which is where all pre-existing data lives.
--   - admin_id: the student -> owning admin edge, and the reason
--     "other admins can't see my students" is expressible at all.
--     Self-referential FK. ON DELETE SET NULL, NOT CASCADE: deleting an
--     admin must never cascade-delete their students -- that would be
--     catastrophic, irreversible data loss from a single action. The
--     students become unassigned and an owner reassigns them.
--   - uq_users_email (global) is KEPT AS-IS, deliberately. A per-org email
--     key was considered and rejected: auth.route.js:90 looks a user up by
--     `WHERE email = ?` alone, so a per-org key would let that query match
--     multiple rows and would require either an org selector in the login
--     UI or an org-identifying subdomain -- neither of which exists. Keeping
--     email globally unique means login needs NO change and this migration
--     carries no behavioural risk to the auth path. The trade-off: one
--     person cannot hold accounts in two different organizations under the
--     same address. That is an acceptable constraint at this stage and can
--     be revisited with a follow-up migration plus a login-flow change if a
--     real multi-org user ever appears.
--   - owner_org_id: a generated column holding org_id for owners and NULL
--     for everyone else, with a UNIQUE index over it. This enforces "at most
--     one owner per organization" in the database rather than in application
--     code. It is the same NULLs-are-never-unique trick 0009 used for
--     active_scheduled_at -- a unique index permits unlimited NULLs, so only
--     owner rows are constrained. Declared PERSISTENT because MariaDB cannot
--     build an index on a VIRTUAL generated column at all (see README).
--   - timezone: added now, defaulted to America/New_York (the value
--     utils/timezone.js currently hardcodes as "Elle's own timezone").
--     Availability and open-slot math becomes per-teacher under this model,
--     so the column is needed eventually; adding it here is nearly free and
--     avoids a second ALTER on this table later. The application deliberately
--     continues to use the hardcoded constant until the tenancy work is
--     otherwise complete -- changing tenancy and DST math in the same slice
--     produces slot bugs that are very hard to reproduce.
--
-- Security: this table holds PII. ENCRYPTION='Y' intentionally NOT specified,
-- same host constraint as every other table. See migrations/README.md.

-- --- role: widen the ENUM, keeping 'elle' for now ---------------------------
ALTER TABLE users
  MODIFY COLUMN role ENUM('elle', 'owner', 'manager', 'admin', 'student') NOT NULL;

-- --- org_id: add nullable, backfill, then tighten --------------------------
ALTER TABLE users
  ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

UPDATE users SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE users
  MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

-- --- elle -> admin ---------------------------------------------------------
-- Every existing teacher account becomes an admin of org 1. The account keeps
-- its id, email and password hash, so all of its existing relationships
-- (students, availability, bookings, messages, videos) remain valid and
-- nothing needs repointing.
UPDATE users SET role = 'admin' WHERE role = 'elle';

-- --- admin_id: the student -> teacher edge ---------------------------------
ALTER TABLE users
  ADD COLUMN admin_id BIGINT UNSIGNED NULL AFTER role;

-- Assign every existing student to the single pre-existing admin. Under the
-- old single-teacher model that is correct by construction: there was exactly
-- one non-student account and it owned every student. MIN(id) makes the choice
-- deterministic if more than one admin somehow exists.
--
-- The nested SELECT is required by MySQL/MariaDB: a subquery in an UPDATE
-- cannot read the table being updated directly, but CAN read a derived table
-- built from it.
UPDATE users
   SET admin_id = (
         SELECT id FROM (
           SELECT MIN(id) AS id FROM users WHERE role = 'admin' AND org_id = 1
         ) AS one_admin
       )
 WHERE role = 'student'
   AND org_id = 1
   AND admin_id IS NULL;

-- admin_id stays NULLABLE, on purpose: owners, managers and admins have no
-- owning admin, so there is no value NOT NULL could take for them. Students
-- with a NULL admin_id are surfaced by the verification query in the header
-- of 0022 rather than being prevented here.

-- --- exactly one owner per organization ------------------------------------
ALTER TABLE users
  ADD COLUMN owner_org_id BIGINT UNSIGNED
    GENERATED ALWAYS AS (CASE WHEN role = 'owner' THEN org_id ELSE NULL END) PERSISTENT;

-- --- per-teacher timezone (column only; app still uses the constant) -------
ALTER TABLE users
  ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'America/New_York';

-- --- indexes ---------------------------------------------------------------
ALTER TABLE users
  ADD UNIQUE KEY uq_users_owner_org_id (owner_org_id);

-- Serves "list every admin in this org" (the owner's roster and the manager's
-- aggregate rollups) and "find the students of this org".
ALTER TABLE users
  ADD KEY idx_users_org_id_role (org_id, role);

-- Serves "list this admin's students", the single most common scoped query
-- under the new model, and satisfies InnoDB's FK-indexing requirement for
-- fk_users_admin_id below.
ALTER TABLE users
  ADD KEY idx_users_admin_id (admin_id);

-- --- foreign keys ----------------------------------------------------------
-- ON DELETE RESTRICT: an organization with users must not be deletable out
-- from under them; removing an org is a deliberate multi-step operation, not
-- a cascade.
ALTER TABLE users
  ADD CONSTRAINT fk_users_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- ON DELETE SET NULL: see the admin_id design note above. Deleting a teacher
-- unassigns their students; it must never delete them.
ALTER TABLE users
  ADD CONSTRAINT fk_users_admin_id
    FOREIGN KEY (admin_id) REFERENCES users (id)
    ON DELETE SET NULL;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE users DROP FOREIGN KEY fk_users_admin_id;
-- ALTER TABLE users DROP FOREIGN KEY fk_users_org_id;
-- ALTER TABLE users DROP INDEX idx_users_admin_id;
-- ALTER TABLE users DROP INDEX idx_users_org_id_role;
-- ALTER TABLE users DROP INDEX uq_users_owner_org_id;
-- ALTER TABLE users DROP COLUMN timezone;
-- ALTER TABLE users DROP COLUMN owner_org_id;
-- ALTER TABLE users DROP COLUMN admin_id;
-- ALTER TABLE users DROP COLUMN org_id;
-- ALTER TABLE users MODIFY COLUMN role ENUM('elle','student') NOT NULL;
