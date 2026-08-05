// Password reset: token issuing, verification and redemption.
//
// Every rule about resets lives here rather than in the route, so the route
// stays a thin HTTP wrapper and a second caller (a CLI "reset this user", an
// owner-initiated reset for a student who has no inbox) reuses the same
// logic instead of reimplementing the security properties.
//
// ROLE HANDLING — the deliberate design decision in this module:
//   Nothing here branches on role. A reset is identified by a token, a token
//   maps to exactly one user row, and that row carries the role. So the flow
//   is automatically correct for owner, manager, admin and student without a
//   single conditional, and `resolveResetToken` returns the role so callers
//   that DO care (the frontend, deciding where to send someone afterwards)
//   are told rather than having to ask.
//
//   This matters because users.email is globally unique (migration 0017):
//   there is no org to disambiguate and no "which account did you mean"
//   step. Branching per role would produce four paths where one suffices,
//   and each extra path is somewhere an authorization bug can hide.

const crypto = require('crypto');
const argon2 = require('argon2');
const pool = require('../db/pool');

// One hour. Long enough to survive a slow inbox, short enough that a link
// left sitting in a mailbox stops being a credential by end of day.
const RESET_TTL_MS = 60 * 60 * 1000;

// 32 bytes of CSPRNG output. Same size as the invitation token, which is the
// app's existing bar for "a URL that grants account access".
const TOKEN_BYTES = 32;

// The database stores only this digest, never the token itself, so a dump of
// password_resets cannot be replayed as a set of working reset links. Plain
// SHA-256 rather than argon2 is correct for a high-entropy random token:
// there is nothing to slow-hash, and lookup must be one indexed probe rather
// than a scan-and-verify across every outstanding row.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Look up a user by email for the purpose of issuing a reset.
//
// Returns null when there is no such account. Callers MUST NOT surface that
// difference — see the note in the route: responding differently for a known
// and unknown address turns this endpoint into an account-existence oracle.
async function findUserByEmail(email, executor = pool) {
  const [rows] = await executor.query(
    'SELECT id, email, name, role FROM users WHERE email = ?',
    [email]
  );
  return rows[0] || null;
}

// Issue a reset token for a user, returning the RAW token (the only moment it
// exists outside the recipient's link).
//
// Any previously outstanding token for the same user is invalidated first.
// Without that, every "I didn't get the email, send another" leaves the older
// link live, so the number of working credentials for one account grows with
// each click.
async function issueResetToken(userId, executor = pool) {
  await invalidateTokensForUser(userId, executor);

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  await executor.query(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, hashToken(token), expiresAt]
  );

  return { token, expiresAt };
}

// Mark every unredeemed token for a user as used.
//
// Called both when issuing a new token and after a successful reset. The
// latter matters: if an attacker had also requested a reset, completing a
// legitimate one must kill their pending link too.
async function invalidateTokensForUser(userId, executor = pool) {
  await executor.query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
}

// Resolve a raw token to the account it unlocks, or null if it is unknown,
// already redeemed, or expired.
//
// Returns the user's role alongside their identity. The reset flow itself
// does not need it, but the caller often does — the frontend uses it to show
// who is resetting and where they will land, which is the "system knows which
// kind of user this is" behaviour, derived from the token rather than asked
// for in the form.
async function resolveResetToken(token, executor = pool) {
  // A malformed token can never match a stored digest, but hashing arbitrary
  // input and probing the index for it is wasted work — reject the obviously
  // wrong shape first.
  if (typeof token !== 'string' || token.length !== TOKEN_BYTES * 2) return null;

  const [rows] = await executor.query(
    `SELECT pr.id AS reset_id,
            pr.expires_at,
            u.id   AS user_id,
            u.email,
            u.name,
            u.role
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ?
        AND pr.used_at IS NULL`,
    [hashToken(token)]
  );

  const row = rows[0];
  if (!row) return null;
  // Expiry is enforced in JS rather than SQL NOW() so the comparison uses the
  // same clock that issued the token.
  if (new Date(row.expires_at) <= new Date()) return null;

  return {
    resetId: row.reset_id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role
  };
}

// Redeem a token: set the new password and burn every outstanding token for
// that account, in one transaction.
//
// Transactional because a partial application here is a security failure, not
// a cosmetic one — a changed password with a still-live token, or a burned
// token with an unchanged password, both leave the account in a state the
// user did not ask for.
//
// Returns the user (including role) so the caller can react without a second
// query. Returns null if the token was not redeemable, which callers report
// identically to "expired" — the distinction is not useful to a legitimate
// user and is useful to an attacker.
async function redeemResetToken(token, newPassword) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Re-resolved INSIDE the transaction. Resolving outside and trusting the
    // result would leave a window where two concurrent redemptions of the
    // same link both pass the check and both set a password.
    const resolved = await resolveResetToken(token, connection);
    if (!resolved) {
      await connection.rollback();
      return null;
    }

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });

    await connection.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, resolved.userId]
    );

    await invalidateTokensForUser(resolved.userId, connection);

    await connection.commit();

    return { id: resolved.userId, email: resolved.email, name: resolved.name, role: resolved.role };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  RESET_TTL_MS,
  hashToken,
  findUserByEmail,
  issueResetToken,
  invalidateTokensForUser,
  resolveResetToken,
  redeemResetToken
};
