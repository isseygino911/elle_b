-- 0016_create_organizations.sql
-- Introduces the tenant root. Every subsequent multi-tenant migration
-- (0017-0021) hangs off this table.
--
-- Context: until now this app had no tenant concept at all -- users.role was
-- ENUM('elle','student') and "the tenant" was the entire database. This file
-- begins the conversion to organization -> owner > manager > admin > student.
--
-- ENGINE NOTE: production is MariaDB 11.8, not MySQL (see migrations/README.md
-- and 0012's header). Every ALTER in this migration set is issued as its own
-- statement, and generated columns use PERSISTENT rather than STORED. Do not
-- batch them back together -- 0012 documents a reproducible errno 121 failure
-- on batched multi-clause ALTER TABLE against this schema.
--
-- Design notes:
--   - id: BIGINT UNSIGNED AUTO_INCREMENT, matching 0001-0015's convention.
--   - name: VARCHAR(255) NOT NULL. Deliberately NOT unique -- two unrelated
--     studios may legitimately both be called "Violin Studio". A tenant's
--     identity is its id; the name is a display label only.
--   - No owner_user_id column here, deliberately. users.org_id (0017) is the
--     edge that ties a person to an org, and a circular FK
--     (organizations -> users -> organizations) would make both the signup
--     INSERT order and any future delete path awkward for no benefit.
--     "Who owns org X" is answered by
--       SELECT id FROM users WHERE org_id = X AND role = 'owner'
--     which uq_users_owner_org_id (0017) guarantees returns at most one row.
--   - created_at: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, matching
--     every other table in this schema.
--
-- Security: holds no PII -- an id, a display name, a timestamp. Same host
-- constraint as 0001-0015 applies: ENCRYPTION='Y' intentionally NOT
-- specified (the Hostinger-managed host has no keyring plugin configured).
-- See migrations/README.md.

CREATE TABLE organizations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- The default organization that all pre-existing production data is
-- backfilled into by 0017-0021. Fixed id=1 so those migrations can reference
-- it as a literal rather than re-deriving it with a subquery each time.
--
-- Guarded with NOT EXISTS rather than a plain INSERT so that re-running this
-- file (or applying it to a database that somehow already holds row 1) is a
-- no-op instead of a duplicate-key failure. The migration runner already
-- skips applied files, so this is belt-and-braces for manual re-application.
INSERT INTO organizations (id, name)
SELECT 1, 'Elle Coaching'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE id = 1);

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS organizations;
