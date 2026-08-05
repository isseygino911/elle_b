-- 0024_library_multi_tenant.sql
-- Scopes the shared library to an organization and, critically, fixes the
-- globally-unique category name.
--
-- THE PROBLEM
-- 0015 declared `UNIQUE KEY uq_library_categories_name (name)`, reasoning that
-- "categories are a small admin-curated set and two categories with the same
-- name would make the move-file UI ambiguous". That reasoning is correct
-- WITHIN one organization and breaks completely across organizations: the
-- second org to create a "Warmups" category receives a 409 caused by another
-- tenant's data. That is both a broken feature and a cross-tenant information
-- leak -- it reveals that some other organization already uses that name.
--
-- THE FIX
-- Replace the single-column unique key with (org_id, name). The original
-- intent -- no two categories with the same name in the same picker -- is
-- preserved exactly; only the scope narrows from global to per-organization.
--
-- ENGINE NOTE: MariaDB 11.8 in production -- one ALTER per statement. See
-- migrations/README.md.
--
-- LIVE DATA: adds columns and re-scopes an index. No row is deleted and no
-- content is rewritten.

-- ===========================================================================
-- library_categories
-- ===========================================================================
ALTER TABLE library_categories ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

UPDATE library_categories c
  JOIN users u ON u.id = c.created_by
   SET c.org_id = u.org_id
 WHERE c.org_id IS NULL;

UPDATE library_categories SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE library_categories MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

-- Swap the global name uniqueness for per-org uniqueness. The DROP must come
-- before the ADD: the two keys cover overlapping columns and MariaDB would
-- otherwise be maintaining a redundant global constraint that still rejects
-- legitimate cross-org names.
ALTER TABLE library_categories
  DROP INDEX uq_library_categories_name;

ALTER TABLE library_categories
  ADD UNIQUE KEY uq_library_categories_org_id_name (org_id, name);

ALTER TABLE library_categories
  ADD CONSTRAINT fk_library_categories_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- ===========================================================================
-- library_files
-- ===========================================================================
ALTER TABLE library_files ADD COLUMN org_id BIGINT UNSIGNED NULL AFTER id;

-- Prefer the owning category's org; fall back to the uploader's for files
-- with no category (0015 permits category_id NULL).
UPDATE library_files f
  LEFT JOIN library_categories c ON c.id = f.category_id
  LEFT JOIN users u ON u.id = f.uploaded_by
   SET f.org_id = COALESCE(c.org_id, u.org_id, 1)
 WHERE f.org_id IS NULL;

UPDATE library_files SET org_id = 1 WHERE org_id IS NULL;

ALTER TABLE library_files MODIFY COLUMN org_id BIGINT UNSIGNED NOT NULL;

-- Serves the library listing, which is always "this org's files, newest
-- first". uq_library_files_s3_key (0015) stays global and correct: an S3 key
-- is unique across the whole bucket regardless of tenant.
ALTER TABLE library_files
  ADD KEY idx_library_files_org_id_created_at (org_id, created_at);

ALTER TABLE library_files
  ADD CONSTRAINT fk_library_files_org_id
    FOREIGN KEY (org_id) REFERENCES organizations (id)
    ON DELETE RESTRICT;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE library_files DROP FOREIGN KEY fk_library_files_org_id;
-- ALTER TABLE library_files DROP INDEX idx_library_files_org_id_created_at;
-- ALTER TABLE library_files DROP COLUMN org_id;
-- ALTER TABLE library_categories DROP FOREIGN KEY fk_library_categories_org_id;
-- ALTER TABLE library_categories DROP INDEX uq_library_categories_org_id_name;
-- ALTER TABLE library_categories ADD UNIQUE KEY uq_library_categories_name (name);
-- ALTER TABLE library_categories DROP COLUMN org_id;
