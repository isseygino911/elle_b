const express = require('express');
const argon2 = require('argon2');
const pool = require('../db/pool');
const config = require('../config/env');
const { createAuthRateLimit } = require('../middleware/rateLimit');
const { validateBody } = require('../middleware/validate');
const { registerSchema, loginSchema } = require('../schemas/auth.schema');
const { signAccessToken, signRefreshToken, verifyToken } = require('../utils/jwt');

const router = express.Router();

const REFRESH_COOKIE_NAME = 'refresh_token';
// Kept in sync with config.jwt.refreshTokenTtl ('7d') — res.cookie() needs a
// milliseconds number, jsonwebtoken's expiresIn takes the '7d' string form.
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const refreshCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: config.nodeEnv === 'production',
  path: '/auth'
};

router.post(
  '/register',
  createAuthRateLimit(),
  validateBody(registerSchema),
  async (req, res, next) => {
    const { token, name, email, password } = req.body;

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [invitationRows] = await connection.query(
        'SELECT id, status, expires_at FROM invitations WHERE token = ? FOR UPDATE',
        [token]
      );
      const invitation = invitationRows[0];
      const isValid =
        !!invitation &&
        invitation.status === 'pending' &&
        invitation.expires_at > new Date();

      if (!isValid) {
        await connection.rollback();
        return res.status(400).json({ status: 'error', message: 'Invitation is invalid or expired' });
      }

      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

      const [insertResult] = await connection.query(
        `INSERT INTO users (role, name, email, password_hash)
         VALUES ('student', ?, ?, ?)`,
        [name, email, passwordHash]
      );
      const userId = insertResult.insertId;

      await connection.query(
        `UPDATE invitations SET status = 'used', user_id = ? WHERE id = ?`,
        [userId, invitation.id]
      );

      await connection.commit();

      res.status(201).json({ id: userId, name, email });
    } catch (err) {
      await connection.rollback();

      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ status: 'error', message: 'Email already registered' });
      }

      next(err);
    } finally {
      connection.release();
    }
  }
);

router.post(
  '/login',
  createAuthRateLimit(),
  validateBody(loginSchema),
  async (req, res, next) => {
    const { email, password } = req.body;

    try {
      const [rows] = await pool.query(
        'SELECT id, role, name, email, password_hash FROM users WHERE email = ?',
        [email]
      );
      const user = rows[0];

      if (!user || !user.password_hash || !(await argon2.verify(user.password_hash, password))) {
        return res.status(401).json({ status: 'error', message: 'Invalid email or password' });
      }

      const accessToken = signAccessToken({ id: user.id, role: user.role, name: user.name, email: user.email });
      const refreshToken = signRefreshToken({ id: user.id });

      res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
        ...refreshCookieOptions,
        maxAge: REFRESH_COOKIE_MAX_AGE_MS
      });

      res.status(200).json({ accessToken });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/refresh', async (req, res, next) => {
  const token = req.cookies && req.cookies[REFRESH_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Missing refresh token' });
  }

  try {
    const payload = verifyToken(token);

    const [rows] = await pool.query('SELECT id, role, name, email FROM users WHERE id = ?', [payload.sub]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ status: 'error', message: 'Invalid refresh token' });
    }

    const accessToken = signAccessToken({ id: user.id, role: user.role, name: user.name, email: user.email });

    res.status(200).json({ accessToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ status: 'error', message: 'Invalid refresh token' });
    }
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions);
  res.status(200).json({ status: 'ok' });
});

module.exports = router;
