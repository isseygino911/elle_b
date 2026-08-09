'use strict';

// Mints access tokens for tests.
//
// Tokens are signed with the real key via src/utils/jwt.js rather than by
// logging in over HTTP. Two reasons: it costs no round trip, and it allows
// constructing tokens the login path would never issue -- specifically one
// whose `adm` claim points at a teacher in ANOTHER organization, which is the
// only practical way to exercise the cross-org notification hole (BUG G).
//
// Because signAccessToken is the same function the app uses, a token from here
// is indistinguishable from a real one to the middleware. If the claim shape
// ever changes, these tokens change with it and nothing silently drifts.

const { signAccessToken } = require('../../src/utils/jwt');

// `user` is a fixture row: { id, orgId, role, adminId, name, email }.
// Overrides are shallow-merged, so a test can bend exactly one claim:
//   tokenFor(student, { adminId: otherOrgTeacher.id })
function tokenFor(user, overrides = {}) {
  return signAccessToken({
    id: user.id,
    orgId: user.orgId,
    role: user.role,
    adminId: user.adminId ?? null,
    name: user.name,
    email: user.email,
    ...overrides
  });
}

function authHeader(user, overrides = {}) {
  return { Authorization: `Bearer ${tokenFor(user, overrides)}` };
}

module.exports = { tokenFor, authHeader };
