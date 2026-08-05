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
