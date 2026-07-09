-- 0001_create_users_and_invitations.sql
-- Creates the `users` and `invitations` tables (Phase 1 domain schema).
--
-- Design notes:
--   - id strategy: BIGINT UNSIGNED AUTO_INCREMENT on both tables. This app
--     runs at ~12-user scale with no multi-master/offline-generation needs,
--     so surrogate auto-increment ints are simplest — no UUID overhead.
--   - users.email: UNIQUE, VARCHAR(255), utf8mb4_0900_ai_ci collation so
--     lookups/uniqueness are case-insensitive (and accent-insensitive),
--     matching how email addresses are treated in practice.
--   - users.password_hash: nullable VARCHAR(255) — NULL until Phase 1's
--     register flow sets it via argon2id; 255 sized generously so encoded
--     hash strings (~95-100 chars) never truncate even if argon2 parameters
--     change later.
--   - invitations.token: server generates via crypto.randomBytes(32) and
--     hex-encodes it, producing a fixed 64-character lowercase hex string.
--     Stored as CHAR(64) with an ascii collation (tokens are hex, never need
--     unicode or case-insensitive matching) — UNIQUE + indexed for fast
--     lookup by token during invite-acceptance.
--   - invitations.status: ENUM('pending','used','expired'), defaults to
--     'pending' since every invitation starts in that state at creation.
--   - invitations.user_id: nullable FK -> users.id, set once the invite is
--     redeemed. ON DELETE SET NULL — deleting a user should not force
--     deletion of the historical invitation record (audit trail survives).
--   - invitations.created_by: NOT NULL FK -> users.id (the Elle account
--     that issued the invite). ON DELETE RESTRICT — an Elle account that
--     has created invitations shouldn't be deletable out from under that
--     history; a real deletion would need to reassign/clean up invitations
--     first via a follow-up migration or explicit app action.
--   - expires_at: DATETIME NOT NULL, set by the app (now + 7 days) at
--     creation time — no DB-side default.
--   - created_at on both tables: TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP.
--
-- Security: both tables hold PII. ENCRYPTION='Y' was originally specified
-- here but has been removed — this project's production host (Hostinger-
-- managed MySQL) does not have the keyring plugin configured, so InnoDB
-- tablespace encryption is not available; at-rest encryption for this data
-- is therefore NOT currently enforced at the database layer.
-- innodb_file_per_table (MySQL 8 default) is still in effect, but that alone
-- does not encrypt data at rest. See server/migrations/README.md.

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role ENUM('elle', 'student') NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token CHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  student_name_hint VARCHAR(255) NULL,
  status ENUM('pending', 'used', 'expired') NOT NULL DEFAULT 'pending',
  user_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitations_token (token),
  CONSTRAINT fk_invitations_user_id
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_invitations_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
    ON DELETE RESTRICT
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js — forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS invitations;
-- DROP TABLE IF EXISTS users;
