const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireCapability } = require('../middleware/auth');
const { CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  createTaskSchema,
  taskIdParamSchema,
  updateTaskStatusSchema,
  listTasksQuerySchema
} = require('../schemas/tasks.schema');
const { serializeTask, fetchScopedTasks } = require('./tasks.helpers');

const router = express.Router();

// Creating a task assigns work to a specific student, so this is a
// per-student action, not a general administrative one -- hence
// requireCapability rather than requireMinRank. A manager is excluded: the
// role is aggregates-only and read-only by design.
router.post('/', requireCapability(CAN_READ_STUDENT_DETAIL), validateBody(createTaskSchema), async (req, res, next) => {
  try {
    const { title, assigned_to, due_date } = req.body;

    if (assigned_to != null) {
      // Scoped to the caller's organization. The previous lookup was
      // `WHERE id = ?` with no tenancy predicate, which turned this endpoint
      // into a cross-tenant user-id oracle: an out-of-org id returned 400 and
      // an in-org one returned 201, so a caller could enumerate which user ids
      // exist anywhere in the system. It also allowed assigning a task to
      // another organization's student outright.
      const [assignedRows] = await pool.query(
        'SELECT id FROM users WHERE id = ? AND org_id = ?',
        [assigned_to, req.user.orgId]
      );
      if (assignedRows.length === 0) {
        return res.status(400).json({ status: 'error', message: 'assigned_to does not reference an existing user' });
      }
    }

    const [result] = await pool.query(
      'INSERT INTO tasks (org_id, title, assigned_to, due_date, created_by) VALUES (?, ?, ?, ?, ?)',
      [req.user.orgId, title, assigned_to ?? null, due_date ?? null, req.user.id]
    );

    const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [result.insertId]);

    res.status(201).json({ task: serializeTask(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth(), validateQuery(listTasksQuerySchema), async (req, res, next) => {
  try {
    const rows = await fetchScopedTasks(req.user, req.query.status);

    res.status(200).json({ tasks: rows.map(serializeTask) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id',
  requireAuth(),
  validateParams(taskIdParamSchema),
  validateBody(updateTaskStatusSchema),
  async (req, res, next) => {
    try {
      // org_id is the tenancy fence and must be present even though
      // created_by/assigned_to already narrow the row. Those two columns point
      // at user ids, and a user reassigned between organizations would
      // otherwise leave a writable handle on their former org's task.
      const [result] = await pool.query(
        'UPDATE tasks SET status = ? WHERE id = ? AND org_id = ? AND (created_by = ? OR assigned_to = ?)',
        [req.body.status, req.params.id, req.user.orgId, req.user.id, req.user.id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Task not found' });
      }

      const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [
        req.params.id,
        req.user.orgId
      ]);

      res.status(200).json({ task: serializeTask(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
