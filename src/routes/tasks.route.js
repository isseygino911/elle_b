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
const { insertNotification } = require('./notifications.helpers');

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

    // Transactional as of Phase 2. The INSERT used to stand alone on the pool,
    // which was fine while nothing accompanied it; now that assigning a task
    // also notifies the assignee, the two must land together or not at all.
    const connection = await pool.getConnection();
    let taskId;

    try {
      await connection.beginTransaction();

      const [result] = await connection.query(
        'INSERT INTO tasks (org_id, title, assigned_to, due_date, created_by) VALUES (?, ?, ?, ?, ?)',
        [req.user.orgId, title, assigned_to ?? null, due_date ?? null, req.user.id]
      );
      taskId = result.insertId;

      // Deliberately NOT resolveRecipients. That helper answers "who is party
      // to this student's lesson", which is the right question for a message or
      // a booking and the wrong one here: a task is a direct instruction to one
      // named person, and copying it to their teacher as well would make every
      // assignment a group announcement.
      //
      // Skipped when assigned_to is null (a personal to-do with no assignee)
      // and when the assignee is the creator (nobody is told about their own
      // action -- the same rule resolveRecipients enforces by construction).
      //
      // assigned_to was confirmed to be in the caller's org above, so the
      // (orgId, userId) pair insertNotification checks is already known good.
      if (assigned_to != null && Number(assigned_to) !== Number(req.user.id)) {
        await insertNotification(connection, {
          orgId: req.user.orgId,
          userId: assigned_to,
          actorId: req.user.id,
          type: 'task_assigned',
          // The task title is carried on the row, unlike a message body. A
          // task is an instruction rather than correspondence, and a
          // notification that cannot say WHICH task was assigned is not
          // actionable.
          title: `New task: ${title}`,
          body: null,
          refId: taskId
        });
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      return next(err);
    } finally {
      connection.release();
    }

    const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ?', [taskId]);

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
      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        // Read BEFORE the update, and lock the row.
        //
        // The UPDATE's own predicate is `(created_by = ? OR assigned_to = ?)`,
        // so affectedRows === 1 proves the caller was ONE of the two but never
        // says which -- and the whole task_completed rule turns on that
        // distinction. A student ticking off their homework is an event the
        // teacher wants; a teacher tidying their own list is not.
        //
        // It also carries the previous status, which is what makes this
        // idempotent: only the transition INTO 'done' is an event, so a
        // re-submitted PATCH (a double tap, an offline queue flushing) writes
        // nothing the second time.
        //
        // FOR UPDATE because between this read and the UPDATE another request
        // could otherwise complete the same task, and both would see a
        // 'pending' previous status and both would notify.
        const [beforeRows] = await connection.query(
          'SELECT status, created_by, assigned_to FROM tasks WHERE id = ? AND org_id = ? FOR UPDATE',
          [req.params.id, req.user.orgId]
        );
        const before = beforeRows[0];

        // org_id is the tenancy fence and must be present even though
        // created_by/assigned_to already narrow the row. Those two columns point
        // at user ids, and a user reassigned between organizations would
        // otherwise leave a writable handle on their former org's task.
        const [result] = await connection.query(
          'UPDATE tasks SET status = ? WHERE id = ? AND org_id = ? AND (created_by = ? OR assigned_to = ?)',
          [req.body.status, req.params.id, req.user.orgId, req.user.id, req.user.id]
        );

        if (result.affectedRows === 0) {
          await connection.rollback();
          return res.status(404).json({ status: 'error', message: 'Task not found' });
        }

        // All four conditions are load-bearing:
        //   - the new status is 'done'          (not a reopen)
        //   - the old status was not 'done'     (a real transition)
        //   - the actor is the assignee         (they did the work)
        //   - the creator is someone else       (no self-notification)
        const completedByAssignee =
          req.body.status === 'done' &&
          before.status !== 'done' &&
          Number(before.assigned_to) === Number(req.user.id) &&
          Number(before.created_by) !== Number(req.user.id);

        if (completedByAssignee) {
          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId: before.created_by,
            actorId: req.user.id,
            type: 'task_completed',
            title: 'Task completed',
            body: null,
            refId: Number(req.params.id)
          });
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
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
