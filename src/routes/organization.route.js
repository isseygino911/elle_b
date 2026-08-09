const crypto = require('crypto');
const path = require('path');
const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES } = require('../constants/roles');
const { validateBody } = require('../middleware/validate');
const { updateOrganizationSchema } = require('../schemas/organization.schema');
const { uploadOrgLogoFile } = require('../middleware/upload');
const { ORGANIZATION_THEMES, DEFAULT_ORGANIZATION_THEME } = require('../constants/theme');
const s3 = require('../services/s3');

const router = express.Router();

// Every query in this file selects this list rather than `*`, so adding a
// column to `organizations` never leaks it to the client by accident.
const ORGANIZATION_COLUMNS = 'id, name, logo_key, show_name_with_logo, theme, created_at';

// The wire shape of an organization. Two things happen here that matter:
//
//   - logo_key becomes logo_url: a presigned S3 URL the browser can put
//     straight in an <img src>, exactly as the library and video routes do.
//     The object stays private and the key never leaves the server. Async for
//     this reason -- signing is a promise -- so every caller awaits it.
//   - show_name_with_logo becomes a real boolean. MySQL hands back 0/1 for
//     TINYINT(1), and `0` arriving in JSON as a number would be truthy-tested
//     correctly but compared (=== true) wrongly by any future caller.
//   - theme falls back to the default rather than trusting the column blindly.
//     The value is a slug the client resolves to a palette, and a row written
//     before 0029 (or by hand) could hold something the frontend has no
//     palette for. Normalising here means every consumer -- not just the
//     settings page -- sees a name that is guaranteed to render.
async function serializeOrganization(row) {
  return {
    id: row.id,
    name: row.name,
    logo_url: row.logo_key ? await s3.getOrgLogoUrl(row.logo_key) : null,
    show_name_with_logo: Boolean(row.show_name_with_logo),
    theme: ORGANIZATION_THEMES.includes(row.theme) ? row.theme : DEFAULT_ORGANIZATION_THEME,
    created_at: row.created_at
  };
}

async function findOrganization(orgId) {
  const [rows] = await pool.query(
    `SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE id = ?`,
    [orgId]
  );
  return rows[0] || null;
}

// The organization a user belongs to.
//
// Until now `organizations` was written once at signup and never read back:
// an owner typed their studio's name into the registration form and it
// disappeared into the database. Every tenant's sidebar said "Elle CRM",
// which in a multi-tenant app means every studio sees somebody else's brand.
//
// requireAuth(), not a capability gate: this is the name on the building.
// Every member of an organization -- including students and managers -- needs
// to see which one they are in, and it discloses nothing they don't already
// know by being a member. `id` comes from the caller's own token, so there is
// no parameter to tamper with and no way to name another tenant's row.
router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const organization = await findOrganization(req.user.orgId);

    if (!organization) {
      // Only reachable if an organization row were deleted out from under a
      // live token. Reported rather than crashing on an undefined below.
      return res.status(404).json({ status: 'error', message: 'Organization not found' });
    }

    res.status(200).json({ organization: await serializeOrganization(organization) });
  } catch (err) {
    next(err);
  }
});

// Rename the organization, set whether its name shows beside the logo, and/or
// choose the accent palette it wears. Owner only.
//
// Deliberately requireRole(OWNER) rather than CAN_READ_STUDENT_DETAIL, which
// would also admit teachers: an admin renaming the whole studio is not a
// teaching action, and the blast radius is every user's sidebar. The owner is
// the only role whose remit is the organization itself.
//
// Scoped by the caller's own orgId for the same reason as the GET -- the
// route takes no id, so an owner can only ever rename their own organization.
router.patch(
  '/',
  requireRole(ROLES.OWNER),
  validateBody(updateOrganizationSchema),
  async (req, res, next) => {
    try {
      const current = await findOrganization(req.user.orgId);
      if (!current) {
        return res.status(404).json({ status: 'error', message: 'Organization not found' });
      }

      // Hiding the name is only meaningful when a logo is there to carry the
      // brand on its own. Allowing it otherwise would leave the sidebar with
      // no mark at all -- so the rule lives here, on the server, and the
      // disabled control in the UI merely reflects it.
      if (req.body.show_name_with_logo === false && !current.logo_key) {
        return res.status(400).json({
          status: 'error',
          message: 'Upload a logo before hiding the organization name'
        });
      }

      // Built from whichever keys arrived rather than always writing both, so
      // saving a rename cannot clobber the toggle with whatever stale value
      // the form was holding (and vice versa).
      const assignments = [];
      const values = [];

      if (req.body.name !== undefined) {
        assignments.push('name = ?');
        values.push(req.body.name);
      }

      if (req.body.show_name_with_logo !== undefined) {
        assignments.push('show_name_with_logo = ?');
        values.push(req.body.show_name_with_logo ? 1 : 0);
      }

      // Already narrowed to a known slug by the schema's z.enum -- nothing
      // arbitrary can reach the column, which is what makes it safe for the
      // client to interpolate into a CSS custom property.
      if (req.body.theme !== undefined) {
        assignments.push('theme = ?');
        values.push(req.body.theme);
      }

      values.push(req.user.orgId);

      await pool.query(
        `UPDATE organizations SET ${assignments.join(', ')} WHERE id = ?`,
        values
      );

      // Re-read rather than echoing req.body: what the client renders should
      // be what the database holds, including any normalisation the column
      // applied on the way in.
      const updated = await findOrganization(req.user.orgId);

      res.status(200).json({ organization: await serializeOrganization(updated) });
    } catch (err) {
      next(err);
    }
  }
);

// Upload (or replace) the organization's brand logo. Owner only -- same
// reasoning as the rename above: this is the mark on every member's sidebar.
//
// requireRole runs before the multer middleware so a non-owner's upload is
// refused before we spend memory buffering their file.
router.post(
  '/logo',
  requireRole(ROLES.OWNER),
  uploadOrgLogoFile('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'No file uploaded' });
      }

      const current = await findOrganization(req.user.orgId);
      if (!current) {
        return res.status(404).json({ status: 'error', message: 'Organization not found' });
      }

      // Mirrors the surveys convention (a UUID per object), but prefixed with
      // the org id so every object in the bucket is attributable to a tenant
      // at a glance. The UUID -- not the original filename -- is what makes
      // the key unguessable and lets the object be cached immutably.
      const extension = path.extname(req.file.originalname).toLowerCase();
      const key = `org-logos/${req.user.orgId}/${crypto.randomUUID()}${extension}`;

      try {
        await s3.putOrgLogoObject(key, req.file.buffer, req.file.mimetype);
      } catch (err) {
        console.error('S3 putOrgLogoObject failed:', err);
        return res.status(502).json({ status: 'error', message: 'Failed to store logo' });
      }

      await pool.query('UPDATE organizations SET logo_key = ? WHERE id = ?', [
        key,
        req.user.orgId
      ]);

      // Best effort, and deliberately after the row is updated: the new logo
      // is already live and correct at this point. A bucket hiccup while
      // tidying up the superseded object leaves an orphan, which is a
      // housekeeping problem -- not a reason to fail an upload that worked.
      if (current.logo_key) {
        try {
          await s3.deleteOrgLogoObject(current.logo_key);
        } catch (err) {
          console.error('S3 deleteOrgLogoObject (previous logo) failed:', err);
        }
      }

      const updated = await findOrganization(req.user.orgId);

      res.status(200).json({ organization: await serializeOrganization(updated) });
    } catch (err) {
      next(err);
    }
  }
);

// Remove the logo and fall back to the text wordmark. Owner only.
router.delete('/logo', requireRole(ROLES.OWNER), async (req, res, next) => {
  try {
    const current = await findOrganization(req.user.orgId);
    if (!current) {
      return res.status(404).json({ status: 'error', message: 'Organization not found' });
    }

    // show_name_with_logo goes back to 1 in the same statement: an org that
    // had hidden its name is otherwise left with no logo AND no name, i.e. an
    // empty sidebar header, and no control to fix it (the toggle disables
    // itself without a logo).
    await pool.query(
      'UPDATE organizations SET logo_key = NULL, show_name_with_logo = 1 WHERE id = ?',
      [req.user.orgId]
    );

    if (current.logo_key) {
      try {
        await s3.deleteOrgLogoObject(current.logo_key);
      } catch (err) {
        console.error('S3 deleteOrgLogoObject failed:', err);
      }
    }

    const updated = await findOrganization(req.user.orgId);

    res.status(200).json({ organization: await serializeOrganization(updated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
