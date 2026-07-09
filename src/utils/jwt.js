// Single place where JWTs are signed/verified. RS256 keypair comes from
// src/config/jwtKeys.js. requireRole (src/middleware/auth.js) is the only
// consumer of verifyToken for incoming requests — no other module should
// call jsonwebtoken directly.

const jwt = require('jsonwebtoken');
const config = require('../config/env');
const keys = require('../config/jwtKeys');

function signAccessToken({ id, role, name, email }) {
  return jwt.sign({ sub: id, role, name, email }, keys.privateKey, {
    algorithm: 'RS256',
    expiresIn: config.jwt.accessTokenTtl
  });
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
