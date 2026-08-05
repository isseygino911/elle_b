const express = require('express');
const argon2 = require('argon2');
const pool = require('../db/pool');
const config = require('../config/env');
const { createAuthRateLimit } = require('../middleware/rateLimit');
const { validateBody } = require('../middleware/validate');
const { registerSchema, registerOrganizationSchema, loginSchema } = require('../schemas/auth.schema');
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

      // org_id, role and created_by are selected because they determine what
      // the new account becomes. created_by in particular has always been
      // recorded but never read -- it is the inviting teacher, and therefore
      // the natural answer to "which admin does this student belong to".
      const [invitationRows] = await connection.query(
        'SELECT id, org_id, role, created_by, status, expires_at FROM invitations WHERE token = ? FOR UPDATE',
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

      // The role comes from the invitation, not a hardcoded 'student'. An
      // owner can therefore invite a manager or an admin, and a teacher can
      // invite students -- who may invite which role is enforced when the
      // invitation is issued (invitations.route.js INVITABLE_ROLES).
      const invitedRole = invitation.role || 'student';

      // Student -> teacher assignment, via the hook that already existed:
      // invitations.created_by records who issued the invite. If that person
      // is an admin, they become the new student's teacher. This is what makes
      // "each student ties to one admin, other admins can't see them" true
      // from the moment the account is created.
      //
      // Only students get an admin_id -- managers and admins have no owning
      // teacher. A student invited by an owner has no admin until one is
      // assigned, which is deliberate: the owner chooses.
      let adminId = null;
      if (invitedRole === 'student') {
        const [inviterRows] = await connection.query(
          'SELECT id, role FROM users WHERE id = ?',
          [invitation.created_by]
        );
        const inviter = inviterRows[0];
        adminId = inviter && inviter.role === 'admin' ? inviter.id : null;
      }

      const [insertResult] = await connection.query(
        `INSERT INTO users (org_id, role, admin_id, name, email, password_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [invitation.org_id, invitedRole, adminId, name, email, passwordHash]
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

// Organization signup. Creates the organization AND its owner in a single
// transaction: an organization must never exist without an owner, so there is
// no orphaned-organization state and no second "claim your seat" flow.
//
// Public and rate-limited, like the other credential endpoints.
router.post(
  '/register-organization',
  createAuthRateLimit(),
  validateBody(registerOrganizationSchema),
  async (req, res, next) => {
    const { organization_name: organizationName, name, email, password } = req.body;

    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

      const [orgResult] = await connection.query(
        'INSERT INTO organizations (name) VALUES (?)',
        [organizationName]
      );
      const orgId = orgResult.insertId;

      // admin_id stays NULL: an owner has no owning teacher. The owner is
      // oversight-only and holds no student roster -- if they also need to
      // teach, a separate admin account is created for that.
      const [userResult] = await connection.query(
        `INSERT INTO users (org_id, role, name, email, password_hash)
         VALUES (?, 'owner', ?, ?, ?)`,
        [orgId, name, email, passwordHash]
      );

      await connection.commit();

      res.status(201).json({
        organization: { id: orgId, name: organizationName },
        user: { id: userResult.insertId, name, email, role: 'owner' }
      });
    } catch (err) {
      await connection.rollback();

      // users.email is globally unique (migration 0017), so a duplicate here
      // means the address is already registered anywhere in the system. The
      // organization INSERT is rolled back with it, so no ownerless
      // organization is left behind.
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
      // org_id and admin_id are selected because signAccessToken needs them
      // for the tenancy claims. users.email remains globally UNIQUE (see
      // migration 0017's design notes), so this lookup still matches at most
      // one row and needs no organization disambiguation.
      const [rows] = await pool.query(
        'SELECT id, org_id, role, admin_id, name, email, password_hash FROM users WHERE email = ?',
        [email]
      );
      const user = rows[0];

      if (!user || !user.password_hash || !(await argon2.verify(user.password_hash, password))) {
        return res.status(401).json({ status: 'error', message: 'Invalid email or password' });
      }

      const accessToken = signAccessToken({
        id: user.id,
        orgId: user.org_id,
        role: user.role,
        adminId: user.admin_id,
        name: user.name,
        email: user.email
      });
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

    // A token can verify cryptographically and still carry no `sub`. Without
    // this guard that undefined reaches the query below as a bind parameter,
    // where mysql2 throws a bare TypeError ("Bind parameters must not contain
    // undefined") that carries no .status -- so the handler at the bottom of
    // app.js renders it as a 500 and the `if (!user)` check further down is
    // never reached. A malformed token is a 401, not a server error, and the
    // difference matters: a 500 doesn't prompt the client to clear its cookie,
    // so the session stays wedged.
    if (payload.sub === undefined || payload.sub === null) {
      return res.status(401).json({ status: 'error', message: 'Invalid refresh token' });
    }

    // Must select org_id and admin_id here too, not just on the login path.
    // Omitting them would mint a tenant-less access token a few minutes after
    // every login -- which the auth middleware then rejects with "Session out
    // of date", logging the user out for no apparent reason.
    //
    // Re-reading the user from the database on every refresh (rather than
    // trusting the refresh token's claims) also means a role change, an org
    // move, or a student's reassignment to a different teacher takes effect on
    // the next refresh instead of being pinned for the token's lifetime.
    const [rows] = await pool.query(
      'SELECT id, org_id, role, admin_id, name, email FROM users WHERE id = ?',
      [payload.sub]
    );
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ status: 'error', message: 'Invalid refresh token' });
    }

    const accessToken = signAccessToken({
      id: user.id,
      orgId: user.org_id,
      role: user.role,
      adminId: user.admin_id,
      name: user.name,
      email: user.email
    });

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
