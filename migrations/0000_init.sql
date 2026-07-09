-- 0000_init.sql
-- Bookkeeping table for the raw-SQL migration runner (server/migrations/run.js).
-- Records which migration files have been applied, by filename (minus .sql).
-- No domain tables belong here — this is Phase 0 scaffolding only.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(20) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Down / rollback:
-- DROP TABLE IF EXISTS schema_migrations;
