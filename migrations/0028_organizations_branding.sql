-- 0028_organizations_branding.sql
-- Gives an organization a brand logo, rendered in the sidebar in place of the
-- lime text wordmark every tenant has shown until now.
--
-- Context: 0016 created `organizations` with a name and a created_at and
-- nothing else, and OrganizationSettingsPage's header comment said branding
-- "is a schema change, not a form field". This is that schema change.
--
-- ENGINE NOTE: production is MariaDB 11.8, not MySQL (see migrations/README.md
-- and 0012's header). Each ALTER is issued as its own statement -- 0012
-- documents a reproducible errno 121 on batched multi-clause ALTER TABLE
-- against this schema. Do not merge these two into one statement.
--
-- Design notes:
--   - logo_key: the S3 object key, NOT the URL. The URL is derivable from
--     key + bucket + region (services/s3.js getOrgLogoPublicUrl), so storing
--     only the key means moving bucket or region is a config change rather
--     than a data migration. NULL means "no logo" -- the sidebar then falls
--     back to the text wordmark, which is exactly today's appearance.
--     VARCHAR(512) because the key is org-scoped and carries a UUID plus the
--     original extension: org-logos/<orgId>/<uuid>.<ext>.
--   - show_name_with_logo: whether the org name renders beside the logo. A
--     logo that already contains a wordmark would otherwise show the studio's
--     name twice. Defaults to 1 so every existing org is visually unchanged by
--     this migration, and is only meaningful when logo_key IS NOT NULL --
--     the route layer refuses to set it to 0 while there is no logo, since
--     that would leave the sidebar with no brand mark at all.
--
-- Security: adds no PII -- an object key and a display flag. Same host
-- constraint as 0001-0027: ENCRYPTION='Y' intentionally NOT specified (the
-- Hostinger-managed host has no keyring plugin configured).

ALTER TABLE organizations
  ADD COLUMN logo_key VARCHAR(512) NULL AFTER name;

ALTER TABLE organizations
  ADD COLUMN show_name_with_logo TINYINT(1) NOT NULL DEFAULT 1 AFTER logo_key;

-- Down / rollback (not executed by run.js -- forward-only convention; kept
-- for reference/manual use only):
-- ALTER TABLE organizations DROP COLUMN show_name_with_logo;
-- ALTER TABLE organizations DROP COLUMN logo_key;
