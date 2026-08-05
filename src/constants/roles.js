// The single source of truth for the role hierarchy. No other module may
// hardcode a role string in a comparison -- import from here instead.
//
// THE HIERARCHY
//   owner   (rank 4) -- one per organization. Sees everything in their org.
//   manager (rank 3) -- AGGREGATES ONLY. Per-admin rollups. Must NEVER read
//                       an individual student's surveys, videos or messages.
//   admin   (rank 2) -- a teacher. Sees only their own students. This is the
//                       old 'elle' role, renamed by migration 0017.
//   student (rank 1) -- sees only themselves.
//
// RANK EXPRESSES ORDERING, NOT CAPABILITY INHERITANCE.
//
// This distinction is the most important thing in this file. `manager`
// outranks `admin` (3 > 2) for administrative seniority, but sees STRICTLY
// LESS per-student data than an admin does. A `rank >= admin` gate would
// therefore hand every manager the entire per-student surface -- which is
// precisely the privacy boundary this hierarchy exists to enforce.
//
// So: rank is only ever used for administrative ordering (requireMinRank).
// Access to an individual student's records is gated exclusively by the
// positive allowlists below (requireCapability). The two are orthogonal and
// must stay that way.
//
// (This role was originally going to be called "superadmin". It was renamed
// to `manager` precisely because "superadmin" universally implies
// most-privileged, and would invite exactly the wrong permission check from
// the next person who reads this code.)

const ROLES = Object.freeze({
  OWNER: 'owner',
  MANAGER: 'manager',
  ADMIN: 'admin',
  STUDENT: 'student'
});

const RANK = Object.freeze({
  [ROLES.OWNER]: 4,
  [ROLES.MANAGER]: 3,
  [ROLES.ADMIN]: 2,
  [ROLES.STUDENT]: 1
});

// Roles permitted to read an INDIVIDUAL student's records -- surveys, videos,
// message threads, comments, booking detail, the student roster.
//
// Positive allowlist: any role not named here is DENIED. A role added to this
// app in future gets no access until someone deliberately adds it, rather than
// inheriting access by default. `manager` is deliberately absent.
const CAN_READ_STUDENT_DETAIL = Object.freeze(new Set([ROLES.OWNER, ROLES.ADMIN]));

// Roles permitted to see cross-admin aggregate rollups (counts and rates, no
// student identities). This is the manager's entire read surface.
const CAN_READ_AGGREGATES = Object.freeze(new Set([ROLES.OWNER, ROLES.MANAGER]));

// Roles that own a roster of students and act as "the teacher" in a
// student-facing interaction. Replaces the premise of the old
// utils/elleUser.js, which assumed exactly one teacher existed.
const IS_TEACHER = Object.freeze(new Set([ROLES.ADMIN]));

// Returns 0 for an unknown role, so an unrecognized value can never satisfy
// a minimum-rank check.
function rankOf(role) {
  return RANK[role] ?? 0;
}

module.exports = {
  ROLES,
  RANK,
  rankOf,
  CAN_READ_STUDENT_DETAIL,
  CAN_READ_AGGREGATES,
  IS_TEACHER
};
