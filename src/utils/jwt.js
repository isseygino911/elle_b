// Single place where JWTs are signed/verified. RS256 keypair comes from
// src/config/jwtKeys.js. requireRole (src/middleware/auth.js) is the only
// consumer of verifyToken for incoming requests — no other module should
// call jsonwebtoken directly.

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const keys = require('../config/jwtKeys');

// Access token claims:
//   sub   user id
//   org   organization id  -- the tenancy fence, added by the multi-tenant work
//   role  owner | manager | admin | student
//   adm   the caller's owning admin (students only; null otherwise)
//   name, email  -- read by the frontend only; the server never trusts them
//
// `org` and `adm` are abbreviated to keep the token small, since every request
// carries it.
//
// IMPORTANT: every caller of this function must pass org_id. A token minted
// without it is rejected by the auth middleware rather than defaulting to any
// organization -- see src/middleware/auth.js. Both the login and the REFRESH
// path must select org_id and admin_id from the database; missing it on the
// refresh path is an easy mistake that would silently mint tenant-less tokens
// a few minutes after every login.
function signAccessToken({ id, orgId, role, adminId, name, email }) {
  return jwt.sign(
    { sub: id, org: orgId, role, adm: adminId ?? null, name, email },
    keys.privateKey,
    {
      algorithm: 'RS256',
      expiresIn: config.jwt.accessTokenTtl
    }
  );
}

function signRefreshToken({ id }) {
  return jwt.sign({ sub: id }, keys.privateKey, {
    algorithm: 'RS256',
    expiresIn: config.jwt.refreshTokenTtl
  });
}

function verifyToken(token) {
  return jwt.verify(token, keys.publicKey, { algorithms: ['RS256'] });
}

module.exports = { signAccessToken, signRefreshToken, verifyToken };
