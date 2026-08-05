-- 0025_create_password_resets.sql
-- Password reset tokens. Until now there was no recovery path at all: a
-- forgotten password locked the account permanently, and because an
-- organization has exactly one owner (0017's owner_org_id unique index), a
-- locked-out owner meant an organization nobody could administer.
--
-- WHY A SEPARATE TABLE, not columns on `users`:
--   A user may legitimately request a reset more than once (the first mail is
--   slow, they click twice, they use two devices). Single reset_token/
--   reset_expires_at columns force each request to overwrite the last, which
--   silently invalidates a link the user may already be holding. A table
--   keeps every outstanding request addressable and auditable.
--
-- WHAT IS STORED IS A HASH, NOT THE TOKEN:
--   token_hash holds SHA-256 of the token; the raw token exists only in the
--   emailed link. A leaked database therefore does not hand an attacker a
--   working reset link for every pending request. SHA-256 (not argon2) is
--   correct here specifically because the token is 32 bytes of CSPRNG output
--   -- there is no low-entropy secret to slow-hash, and the lookup has to be
--   a single indexed probe rather than a scan-and-verify over every row.
--
-- ROLE-AGNOSTIC BY DESIGN:
--   No role column. users.email is globally unique (0017), so a token
--   identifies exactly one user and their role travels with that row. Reset
--   is the one flow in this app that must behave identically for owner,
--   manager, admin and student -- branching on role here would create four
--   code paths where one suffices, and every extra path is a place for an
--   authorization bug to hide.
--
-- ENGINE NOTE: MariaDB 11.8 in production. Each ALTER is its own statement
-- per the convention established in 0012/0017 (batched multi-clause ALTER
-- TABLE reproduces errno 121 here).

CREATE TABLE password_resets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  -- SHA-256 hex digest: fixed 64 ascii chars. ascii collation so the unique
  -- index compares bytes rather than doing a case/accent-insensitive utf8mb4
  -- comparison, which would treat distinct digests as colliding.
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  expires_at DATETIME NOT NULL,
  -- NULL until redeemed. Recording the time (rather than a boolean) makes a
  -- replayed link distinguishable from a merely expired one in the logs.
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_resets_token_hash (token_hash),
  -- Supports "invalidate every outstanding token for this user", which runs
  -- on each successful reset and on each new request.
  KEY idx_password_resets_user_id_used_at (user_id, used_at),
  -- ON DELETE CASCADE: a deleted user's pending reset tokens are meaningless
  -- and must not outlive the account they unlock.
  CONSTRAINT fk_password_resets_user_id
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_0900_ai_ci;

-- Down / rollback (not executed by run.js — forward-only convention; kept
-- for reference/manual use only):
-- DROP TABLE IF EXISTS password_resets;
