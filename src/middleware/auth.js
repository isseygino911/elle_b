// The only place access-token verification/role-checking logic lives.
// Usage: router.post('/invitations', requireRole('elle'), handler)
//        router.get('/surveys', requireAuth(), handler)

const { verifyToken } = require('../utils/jwt');

// Shared verification step used by both requireRole and requireAuth — pulls
// the bearer token off the request, verifies it, and sets req.user. Returns
// true if verification succeeded (and the caller should proceed to any
// further role check), false if it already sent a 401 response.
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

  req.user = { id: payload.sub, role: payload.role };
  return true;
}

function requireRole(role) {
  return function (req, res, next) {
    if (!authenticate(req, res)) {
      return;
    }

    if (req.user.role !== role) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }

    next();
  };
}

function requireAuth() {
  return function (req, res, next) {
    if (!authenticate(req, res)) {
      return;
    }

    next();
  };
}

module.exports = { requireRole, requireAuth };
