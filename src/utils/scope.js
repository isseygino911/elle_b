// Builds the tenancy WHERE fragment for a query, by POSITIVE allowlist.
//
// WHY THIS MODULE EXISTS
// The pre-multi-tenant codebase scoped queries NEGATIVELY:
//
//     if (user.role === 'student') { conditions.push('assigned_to = ?') }
//     // ...else: no condition at all, i.e. see every row in the table
//
// That shape appeared in tasks.helpers.js, bookings.helpers.js,
// videos.route.js and surveys.route.js, plus a SQL-level variant in
// bookings.route.js ("AND (? = 'elle' OR student_id = ?)"). It was correct
// when the only two roles were 'elle' and 'student'. It is actively dangerous
// the moment a third role exists: ADDING a role silently grants it access to
// every row, because it simply falls into the `else`.
//
// Under the new hierarchy that would hand `manager` -- the aggregates-only
// oversight role -- every student's records. Exactly the privacy boundary the
// hierarchy exists to enforce.
//
// So this helper inverts the default. Every role must be named explicitly,
// and an unrecognized role THROWS rather than returning an empty
// (match-everything) predicate. The failure mode is "no rows", never
// "all rows".
//
// USAGE
//   const scope = scopeFor(req.user, { org: 'org_id', admin: 'admin_id', student: 'student_id' });
//   const [rows] = await pool.query(
//     `SELECT * FROM videos WHERE ${scope.sql}`, scope.params
//   );
//
// `columns` names the tenancy columns AS THEY APPEAR IN THIS QUERY -- pass
// qualified names ('b.org_id') when the query joins. Any key omitted means
// that scoping level is not expressible on this table, and a role that
// requires it is rejected rather than silently widened.

const { ROLES } = require('../constants/roles');

// Carries status 403 so app.js's fallback error handler (which honours
// err.status) turns a throw into a clean Forbidden with no per-route
// try/catch.
class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeError';
    this.status = 403;
  }
}

function scopeFor(user, columns) {
  if (!user || !user.role) {
    throw new ScopeError('Not authorized');
  }

  const { org, admin, student } = columns || {};

  switch (user.role) {
    // Owner: everything inside their own organization, and never outside it.
    case ROLES.OWNER:
      if (!org) {
        throw new ScopeError('Not accessible to this role');
      }
      return { sql: `${org} = ?`, params: [user.orgId] };

    // Admin (teacher): only rows belonging to them.
    //
    // The org-only fallback is for tables that genuinely have no admin column
    // -- surveys, for instance, which migration 0012 made org-level curriculum
    // visible to every student. It is NOT a general escape hatch: a table that
    // has an admin column must always pass it, or an admin would see peers'
    // rows.
    case ROLES.ADMIN:
      if (admin) {
        return { sql: `${org} = ? AND ${admin} = ?`, params: [user.orgId, user.id] };
      }
      if (org) {
        return { sql: `${org} = ?`, params: [user.orgId] };
      }
      throw new ScopeError('Not accessible to this role');

    // Student: only their own rows.
    case ROLES.STUDENT:
      if (!student) {
        throw new ScopeError('Not accessible to this role');
      }
      return { sql: `${org} = ? AND ${student} = ?`, params: [user.orgId, user.id] };

    // Manager: NEVER row-level content. Managers read aggregates only, via the
    // manager branch of GET /dashboard (buildManagerDashboard in
    // dashboard.route.js), which builds its own org-scoped GROUP BY queries and
    // does not go through this helper.
    //
    // Reaching here means a manager hit a row-level endpoint that should have
    // been blocked upstream by requireCapability(CAN_READ_STUDENT_DETAIL). This
    // throws rather than returning a predicate, so the boundary holds even if a
    // route forgets its middleware -- defence in depth, failing closed.
    case ROLES.MANAGER:
      throw new ScopeError('Managers may only access aggregate reports');

    default:
      throw new ScopeError('Unrecognized role');
  }
}

module.exports = { scopeFor, ScopeError };
