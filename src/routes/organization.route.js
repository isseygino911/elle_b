const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES } = require('../constants/roles');
const { validateBody } = require('../middleware/validate');
const { updateOrganizationSchema } = require('../schemas/organization.schema');

const router = express.Router();

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
    const [rows] = await pool.query(
      'SELECT id, name, created_at FROM organizations WHERE id = ?',
      [req.user.orgId]
    );

    const organization = rows[0];
    if (!organization) {
      // Only reachable if an organization row were deleted out from under a
      // live token. Reported rather than crashing on an undefined below.
      return res.status(404).json({ status: 'error', message: 'Organization not found' });
    }

    res.status(200).json({ organization });
  } catch (err) {
    next(err);
  }
});

// Rename the organization. Owner only.
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
      await pool.query('UPDATE organizations SET name = ? WHERE id = ?', [
        req.body.name,
        req.user.orgId
      ]);

      // Re-read rather than echoing req.body: what the client renders should
      // be what the database holds, including any normalisation the column
      // applied on the way in.
      const [rows] = await pool.query(
        'SELECT id, name, created_at FROM organizations WHERE id = ?',
        [req.user.orgId]
      );

      res.status(200).json({ organization: rows[0] });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
