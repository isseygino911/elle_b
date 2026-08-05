// Shared by tasks.route.js's GET / and dashboard.route.js's tasks section, so
// the role-scoping rule lives in exactly one place.
//
// Scoping is delegated to utils/scope.js. This function previously scoped
// NEGATIVELY -- "if student, filter by assigned_to; otherwise no WHERE clause
// at all" -- which silently granted every non-student role every task in the
// database. See utils/scope.js's header for why that shape was removed.

const pool = require('../db/pool');
const { scopeFor } = require('../utils/scope');

// mysql2 returns DATE columns as JS Date objects (constructed at local
// midnight in the server's timezone), which would otherwise implicitly
// serialize via Date.prototype.toJSON() into a full UTC timestamp. due_date
// is a plain calendar date with no time-of-day meaning (see
// 0006_create_tasks.sql), so it must come back as YYYY-MM-DD. Reading the
// local y/m/d back off the Date object (instead of toISOString(), which
// converts to UTC) avoids shifting the date across a UTC-offset boundary.
function formatDateOnly(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (!(value instanceof Date)) {
    return value;
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Shapes a `tasks` row for API responses — plain passthrough, no joins
// needed (matching notifications.route.js's simplicity).
function serializeTask(row) {
  return {
    id: row.id,
    title: row.title,
    assigned_to: row.assigned_to,
    status: row.status,
    due_date: formatDateOnly(row.due_date),
    created_by: row.created_by,
    created_at: row.created_at
  };
}

async function fetchScopedTasks(user, statusFilter) {
  // A task's owner is the student it is assigned to. Tasks have no admin_id
  // column -- ownership is already expressed by created_by/assigned_to, and
  // org_id is the tenancy fence (see migration 0023) -- so an admin sees every
  // task in their organization rather than only their own students'.
  const scope = scopeFor(user, { org: 'org_id', student: 'assigned_to' });

  // Always at least one condition, so the `conditions.length ? ... : ''`
  // branch that used to produce a completely unscoped query is gone by
  // construction.
  const conditions = [scope.sql];
  const params = [...scope.params];

  if (statusFilter) {
    conditions.push('status = ?');
    params.push(statusFilter);
  }

  const [rows] = await pool.query(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params
  );
  return rows;
}

module.exports = { serializeTask, fetchScopedTasks };
