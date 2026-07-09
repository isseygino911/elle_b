const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  createTaskSchema,
  taskIdParamSchema,
  updateTaskStatusSchema,
  listTasksQuerySchema
} = require('../schemas/tasks.schema');
const { serializeTask, fetchScopedTasks } = require('./tasks.helpers');

const router = express.Router();

router.post('/', requireRole('elle'), validateBody(createTaskSchema), async (req, res, next) => {
  try {
    const { title, assigned_to, due_date } = req.body;

    if (assigned_to != null) {
      const [assignedRows] = await pool.query('SELECT id FROM users WHERE id = ?', [assigned_to]);
      if (assignedRows.length === 0) {
        return res.status(400).json({ status: 'error', message: 'assigned_to does not reference an existing user' });
      }
    }

    const [result] = await pool.query(
      'INSERT INTO tasks (title, assigned_to, due_date, created_by) VALUES (?, ?, ?, ?)',
      [title, assigned_to ?? null, due_date ?? null, req.user.id]
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
      const [result] = await pool.query(
        'UPDATE tasks SET status = ? WHERE id = ? AND (created_by = ? OR assigned_to = ?)',
        [req.body.status, req.params.id, req.user.id, req.user.id]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Task not found' });
      }

      const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [req.params.id]);

      res.status(200).json({ task: serializeTask(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
