// The only place access-token verification and role checking live.
//
// FOUR GATES, EACH WITH A DISTINCT JOB. Picking the wrong one is how privacy
// boundaries leak, so read this before choosing:
//
//   requireAuth()                     -- authenticated, any role.
//
//   requireRole(...roles)             -- exact allowlist. For endpoints that
//                                        belong to specific roles regardless of
//                                        seniority (e.g. submitting a survey
//                                        answer is student-only and must NOT be
//                                        reachable by an admin).
//
//   requireMinRank(role)              -- ADMINISTRATIVE actions only, where
//                                        seniority genuinely implies capability.
//                                        NEVER use this to guard per-student
//                                        data: `manager` outranks `admin` but
//                                        must see strictly less. See
//                                        src/constants/roles.js.
//
//   requireCapability(set)            -- the ONLY gate that may guard access to
//                                        an individual student's records. Takes
//                                        a positive allowlist from
//                                        constants/roles.js.
//
// Usage:
//   router.get('/students', requireCapability(CAN_READ_STUDENT_DETAIL), handler)
//   router.post('/surveys/:id/answers', requireRole(ROLES.STUDENT), handler)

const { verifyToken } = require('../utils/jwt');
const { rankOf } = require('../constants/roles');

// Shared verification step used by every gate below -- pulls the bearer token
// off the request, verifies it, and populates req.user. Returns true if the
// caller should proceed to any further check, false if it already sent a 401.
function authenticate(req, res) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ status: 'error', message: 'Missing or invalid access token' });
    return false;
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    res.status(401).json({ status: 'error', message: 'Missing or invalid access token' });
    return false;
  }

  // A token minted before the multi-tenant migration carries no `org` claim.
  // Rejecting it outright is deliberate: defaulting to org 1 (or to "no
  // tenant") would let a stale token read another organization's data, and
  // every downstream query trusts req.user.orgId as the tenancy fence.
  //
  // The cost is one 401 per user holding an old token; their client refreshes
  // and the new token carries the claim. Access-token TTL is short, so this
  // window is minutes at deploy time, not an ongoing condition.
  if (payload.org === undefined || payload.org === null) {
    res
      .status(401)
      .json({ status: 'error', message: 'Session out of date, please sign in again' });
    return false;
  }

  // Same fail-closed reasoning for the subject claim. req.user.id becomes a
  // bind parameter in nearly every downstream query, and an undefined there is
  // a driver-level TypeError rendered as a 500 rather than the 401 this
  // actually is.
  if (payload.sub === undefined || payload.sub === null) {
    res.status(401).json({ status: 'error', message: 'Missing or invalid access token' });
    return false;
  }

  req.user = {
    id: payload.sub,
    orgId: payload.org,
    role: payload.role,
    // The student's owning admin. Null for owners, managers and admins, who
    // have no owning teacher.
    adminId: payload.adm ?? null
  };

  return true;
}

function requireAuth() {
  return function (req, res, next) {
    if (!authenticate(req, res)) {
      return;
    }

    next();
  };
}

// Exact-match allowlist. Accepts one or more roles:
//   requireRole(ROLES.STUDENT)
//   requireRole(ROLES.OWNER, ROLES.ADMIN)
function requireRole(...roles) {
  const allowed = new Set(roles);

  return function (req, res, next) {
    if (!authenticate(req, res)) {
      return;
    }

    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }

    next();
  };
}

// Rank gate, for administrative actions where seniority implies capability --
// managing availability, issuing invitations, curating the shared library.
//
// NOT appropriate for per-student data access. rankOf() returns 0 for an
// unknown role, so an unrecognized value can never satisfy a minimum.
function requireMinRank(minRole) {
  const min = rankOf(minRole);

  return function (req, res, next) {
    if (!authenticate(req, res)) {
      return;
    }

    if (rankOf(req.user.role) < min) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }

    next();
  };
}

// Positive capability gate -- the only thing guarding per-student detail.
// `capabilitySet` is one of the Sets exported by src/constants/roles.js.
function requireCapability(capabilitySet) {
  return function (req, res, next) {
    if (!authenticate(req, res)) {
      return;
    }

    if (!capabilitySet.has(req.user.role)) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }

    next();
  };
}

module.exports = { requireAuth, requireRole, requireMinRank, requireCapability };
