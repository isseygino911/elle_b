// Shared by tasks.route.js's GET / and dashboard.route.js's tasks section, so
// the role-scoping rule (elle sees all tasks, a student sees only tasks
// assigned to them) lives in exactly one place.

const pool = require('../db/pool');

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
  const conditions = [];
  const params = [];

  if (user.role === 'student') {
    conditions.push('assigned_to = ?');
    params.push(user.id);
  }

  if (statusFilter) {
    conditions.push('status = ?');
    params.push(statusFilter);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.query(`SELECT * FROM tasks ${where} ORDER BY created_at ASC`, params);
  return rows;
}

module.exports = { serializeTask, fetchScopedTasks };
