const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const config = require('../config/env');
const { requireCapability } = require('../middleware/auth');
const { ROLES, CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateBody, validateParams } = require('../middleware/validate');
const {
  createInvitationSchema,
  tokenParamSchema
} = require('../schemas/auth.schema');

const router = express.Router();

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Who may invite whom:
//   owner -> manager, admin, student   (an owner staffs their organization)
//   admin -> student only              (a teacher grows their own roster)
//   manager, student -> nobody
//
// An admin must not be able to mint another admin or a manager, which would
// be a privilege-escalation path: any teacher could otherwise create an
// account that outranks them.
const INVITABLE_ROLES = {
  [ROLES.OWNER]: new Set([ROLES.MANAGER, ROLES.ADMIN, ROLES.STUDENT]),
  [ROLES.ADMIN]: new Set([ROLES.STUDENT])
};

router.post(
  '/',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateBody(createInvitationSchema),
  async (req, res, next) => {
    const { student_name_hint: studentNameHint } = req.body;

    // Defaults to 'student', which is what every invitation meant before the
    // multi-tenant work and what the existing client still sends.
    const invitedRole = req.body.role || ROLES.STUDENT;

    const allowed = INVITABLE_ROLES[req.user.role];
    if (!allowed || !allowed.has(invitedRole)) {
      return res
        .status(403)
        .json({ status: 'error', message: `You may not invite a ${invitedRole}` });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    try {
      await pool.query(
        `INSERT INTO invitations (org_id, role, token, student_name_hint, status, created_by, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        [req.user.orgId, invitedRole, token, studentNameHint || null, req.user.id, expiresAt]
      );

      res.status(201).json({ link: `${config.corsOrigin}/register?token=${token}` });
    } catch (err) {
      next(err);
    }
  }
);

// The other half of the invite flow. Issuing an invitation handed back a link
// once and then forgot it: there was no way to see who had been invited, who
// had not yet joined, or whether a link had already been redeemed. Migration
// 0023 added idx_invitations_org_id_status for exactly this query and nothing
// ever ran it.
//
// Scoped by org_id, and gated on the same capability as issuing one, so a
// caller only ever sees invitations for their own organization. An admin sees
// only the ones they created — they can invite students, so showing them the
// owner's pending manager and admin invites would leak the org's staffing
// plans to every teacher. The owner sees all of them.
//
// The token itself is deliberately NOT selected. It is the bearer credential:
// anyone holding it can claim the account. Re-displaying it here would put
// every outstanding credential in the org onto one screen, so a lost link is
// reissued rather than looked up.
router.get('/', requireCapability(CAN_READ_STUDENT_DETAIL), async (req, res, next) => {
  try {
    const ownerScoped = req.user.role === ROLES.OWNER;

    const [rows] = await pool.query(
      `SELECT i.id,
              i.role,
              i.student_name_hint,
              i.status,
              i.expires_at,
              i.created_at,
              i.user_id,
              u.name AS accepted_by_name,
              c.name AS created_by_name
         FROM invitations i
         LEFT JOIN users u ON u.id = i.user_id
         LEFT JOIN users c ON c.id = i.created_by
        WHERE i.org_id = ?
          ${ownerScoped ? '' : 'AND i.created_by = ?'}
        ORDER BY i.created_at DESC
        LIMIT 200`,
      ownerScoped ? [req.user.orgId] : [req.user.orgId, req.user.id]
    );

    // `expired` is derived, not stored. Nothing sweeps the table to flip
    // status when expires_at passes, so a row can sit at 'pending' long after
    // the link stopped working. Computing it per-row keeps the list honest
    // without a background job.
    const now = new Date();
    const invitations = rows.map((row) => ({
      id: row.id,
      role: row.role,
      student_name_hint: row.student_name_hint,
      status: row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status,
      expires_at: row.expires_at,
      created_at: row.created_at,
      accepted_by_name: row.accepted_by_name ?? null,
      created_by_name: row.created_by_name ?? null
    }));

    res.status(200).json({ invitations });
  } catch (err) {
    next(err);
  }
});

// Must stay below GET '/' — this path is unauthenticated (the invitee has no
// account yet) and ':token' would otherwise capture the bare '/' listing and
// serve it to anyone.
router.get(
  '/:token',
  validateParams(tokenParamSchema),
  async (req, res, next) => {
    try {
      const [rows] = await pool.query(
        'SELECT status, expires_at FROM invitations WHERE token = ?',
        [req.params.token]
      );

      const invitation = rows[0];
      const valid =
        !!invitation &&
        invitation.status === 'pending' &&
        invitation.expires_at > new Date();

      res.status(200).json({ valid });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
