const express = require('express');
const pool = require('../db/pool');
const { requireCapability } = require('../middleware/auth');
const { CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateBody, validateParams } = require('../middleware/validate');
const { createAvailabilitySchema, availabilityIdParamSchema } = require('../schemas/availability.schema');
const { resolveCalendarAdminId } = require('../utils/calendarAdmin');

const router = express.Router();

// Shapes an `availability` row for API responses — plain passthrough, no
// joins needed (matching notifications.route.js's simplicity). TIME columns
// come back from mysql2 as plain "HH:MM:SS" strings, not JS Date objects,
// so no timezone-reinterpretation handling is needed here (contrast with
// bookings.helpers.js's DATETIME handling).
function serializeAvailability(row) {
  return {
    id: row.id,
    day_of_week: row.day_of_week,
    start_time: row.start_time,
    end_time: row.end_time
  };
}

router.post('/', requireCapability(CAN_READ_STUDENT_DETAIL), validateBody(createAvailabilitySchema), async (req, res, next) => {
  try {
    const { day_of_week, start_time, end_time } = req.body;

    // admin_id, not org_id: an availability window is one specific teacher's
    // weekly schedule (see migration 0019). An owner managing availability
    // does so on behalf of a specific teacher, named via admin_id -- binding
    // req.user.id here would file the window under the owner's own id, where
    // computeOpenSlots (which always queries a real teacher's id) would never
    // read it back.
    const adminId = await resolveCalendarAdminId(req, res);
    if (adminId === null) {
      return;
    }

    const [result] = await pool.query(
      'INSERT INTO availability (admin_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?)',
      [adminId, day_of_week, start_time, end_time]
    );

    const [rows] = await pool.query('SELECT * FROM availability WHERE id = ?', [result.insertId]);

    res.status(201).json({ availability: serializeAvailability(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// requireCapability(CAN_READ_STUDENT_DETAIL), not requireAuth() — students don't need the raw
// recurring rule, only computed open slots via GET /bookings/open-slots.
router.get('/', requireCapability(CAN_READ_STUDENT_DETAIL), async (req, res, next) => {
  try {
    // Scoped to one teacher's calendar. Previously this returned EVERY
    // teacher's windows to every caller, so each teacher saw the union of all
    // schedules -- and computeOpenSlots would then offer their students hours
    // that belong to somebody else.
    const adminId = await resolveCalendarAdminId(req, res);
    if (adminId === null) {
      return;
    }

    const [rows] = await pool.query(
      'SELECT id, day_of_week, start_time, end_time FROM availability WHERE admin_id = ? ORDER BY day_of_week ASC, start_time ASC',
      [adminId]
    );

    res.status(200).json({ availability: rows.map(serializeAvailability) });
  } catch (err) {
    next(err);
  }
});

router.delete(
  '/:id',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateParams(availabilityIdParamSchema),
  async (req, res, next) => {
    try {
      const adminId = await resolveCalendarAdminId(req, res);
      if (adminId === null) {
        return;
      }

      // admin_id in the predicate, not just the id: without it one teacher
      // could delete another teacher's schedule by guessing a row id.
      const [result] = await pool.query(
        'DELETE FROM availability WHERE id = ? AND admin_id = ?',
        [req.params.id, adminId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Availability window not found' });
      }

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateParams(availabilityIdParamSchema),
  validateBody(createAvailabilitySchema),
  async (req, res, next) => {
    try {
      const { day_of_week, start_time, end_time } = req.body;

      const adminId = await resolveCalendarAdminId(req, res);
      if (adminId === null) {
        return;
      }

      let result;
      try {
        [result] = await pool.query(
          'UPDATE availability SET day_of_week = ?, start_time = ?, end_time = ? WHERE id = ? AND admin_id = ?',
          [day_of_week, start_time, end_time, req.params.id, adminId]
        );
      } catch (err) {
        if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
          return res.status(400).json({ status: 'error', message: 'end_time must be after start_time' });
        }
        throw err;
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Availability window not found' });
      }

      const [rows] = await pool.query(
        'SELECT * FROM availability WHERE id = ? AND admin_id = ?',
        [req.params.id, adminId]
      );

      res.status(200).json({ availability: serializeAvailability(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
