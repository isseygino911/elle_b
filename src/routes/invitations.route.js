const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const config = require('../config/env');
const { requireRole } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const {
  createInvitationSchema,
  tokenParamSchema
} = require('../schemas/auth.schema');

const router = express.Router();

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

router.post(
  '/',
  requireRole('elle'),
  validateBody(createInvitationSchema),
  async (req, res, next) => {
    const { student_name_hint: studentNameHint } = req.body;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    try {
      await pool.query(
        `INSERT INTO invitations (token, student_name_hint, status, created_by, expires_at)
         VALUES (?, ?, 'pending', ?, ?)`,
        [token, studentNameHint || null, req.user.id, expiresAt]
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
