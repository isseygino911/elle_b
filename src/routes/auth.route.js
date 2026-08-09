const express = require('express');
const argon2 = require('argon2');
const pool = require('../db/pool');
const config = require('../config/env');
const { createAuthRateLimit } = require('../middleware/rateLimit');
const { validateBody, validateParams } = require('../middleware/validate');
const {
  registerSchema,
  registerOrganizationSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resetTokenParamSchema
} = require('../schemas/auth.schema');
const { signAccessToken, signRefreshToken, verifyToken } = require('../utils/jwt');
const {
  findUserByEmail,
  issueResetToken,
  resolveResetToken,
  redeemResetToken
} = require('../utils/passwordReset');
const { sendPasswordResetEmail } = require('../utils/mailer');
const { insertNotification } = require('./notifications.helpers');

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

      // The one notification on an unauthenticated path. There is no req.user
      // here -- the actor is the account that has just this moment been
      // created, and the recipient is whoever issued the invitation.
      //
      // Both org and recipient come from the invitation row read inside this
      // transaction, never from the request: invitations.org_id is NOT NULL
      // with an FK (migration 0023), and created_by is ON DELETE RESTRICT
      // (0001), so the inviter provably still exists and provably belongs to
      // the org whose invitation this is.
      //
      // Wrapped in its own try/catch, unlike every other call site. Elsewhere a
      // failed notification SHOULD roll the triggering action back; here it
      // must not. Registration is the one irreversible, user-facing action in
      // the app -- the invitation token is single-use and the account is the
      // point of the request -- so a notification defect must never be the
      // reason someone cannot create their account. The insert is best-effort
      // and logged; the registration stands.
      try {
        await insertNotification(connection, {
          orgId: invitation.org_id,
          userId: invitation.created_by,
          actorId: userId,
          type: 'invitation_accepted',
          title: `${name} accepted your invitation`,
          body: null,
          refId: invitation.id
        });
      } catch (notifyErr) {
        console.error(
          `[notifications] invitation ${invitation.id} accepted by user ${userId} ` +
            'but the notification could not be written:',
          notifyErr
        );
      }

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

// Request a reset link.
//
// ALWAYS responds 200 with the same body, whether or not the address matches
// an account. The obvious alternative — 404 for an unknown email — turns this
// into an account-existence oracle that anyone can query without
// authenticating, which is worse than useless given users.email is globally
// unique: it would confirm not just "is this person a customer" but "is this
// address registered anywhere in the system".
//
// Rate-limited on the same basis as login: it sends mail and probes the user
// table, both of which are worth throttling.
router.post(
  '/forgot-password',
  createAuthRateLimit(),
  validateBody(forgotPasswordSchema),
  async (req, res, next) => {
    try {
      const user = await findUserByEmail(req.body.email);

      if (user) {
        const { token } = await issueResetToken(user.id);
        // Awaited so a transport failure is caught here rather than surfacing
        // as an unhandled rejection. The response does not depend on it.
        await sendPasswordResetEmail({ to: user.email, name: user.name, token });
      }

      res.status(200).json({
        status: 'ok',
        message: 'If that email is registered, a reset link has been sent.'
      });
    } catch (err) {
      next(err);
    }
  }
);

// Check a reset link before showing the form, and report whose it is.
//
// Returning name and role is what lets the reset page greet the user and say
// what kind of account they are restoring, without the person having to
// re-enter an email the token already identifies. Only ever reached by
// someone already holding the token, which is itself the credential — so this
// discloses nothing they could not learn by completing the reset.
//
// Deliberately NOT returning the email address: a reset link that leaks from
// a forwarded mail or a shared screen would otherwise hand over the account's
// login identifier as well.
router.get(
  '/reset-password/:token',
  validateParams(resetTokenParamSchema),
  async (req, res, next) => {
    try {
      const resolved = await resolveResetToken(req.params.token);

      if (!resolved) {
        return res.status(200).json({ valid: false });
      }

      res.status(200).json({
        valid: true,
        name: resolved.name,
        role: resolved.role
      });
    } catch (err) {
      next(err);
    }
  }
);

// Complete the reset.
//
// No tokens are issued here and the user is not logged in as a side effect:
// they set a password and then use it, which matches how registration already
// behaves in this app and means a reset link alone never becomes a live
// session. Every other outstanding reset token for the account is burned
// inside the same transaction (see redeemResetToken).
router.post(
  '/reset-password',
  createAuthRateLimit(),
  validateBody(resetPasswordSchema),
  async (req, res, next) => {
    try {
      const user = await redeemResetToken(req.body.token, req.body.password);

      if (!user) {
        return res.status(400).json({
          status: 'error',
          message: 'This reset link is invalid or has expired.'
        });
      }

      // Role is echoed back so the client can route the user to the right
      // place after they log in, without decoding anything itself.
      res.status(200).json({ status: 'ok', role: user.role });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/logout', (req, res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions);
  res.status(200).json({ status: 'ok' });
});

module.exports = router;
