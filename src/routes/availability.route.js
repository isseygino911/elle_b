const express = require('express');
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth');
const { validateBody, validateParams } = require('../middleware/validate');
const { createAvailabilitySchema, availabilityIdParamSchema } = require('../schemas/availability.schema');

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

router.post('/', requireRole('elle'), validateBody(createAvailabilitySchema), async (req, res, next) => {
  try {
    const { day_of_week, start_time, end_time } = req.body;

    const [result] = await pool.query(
      'INSERT INTO availability (day_of_week, start_time, end_time) VALUES (?, ?, ?)',
      [day_of_week, start_time, end_time]
    );

    const [rows] = await pool.query('SELECT * FROM availability WHERE id = ?', [result.insertId]);

    res.status(201).json({ availability: serializeAvailability(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// requireRole('elle'), not requireAuth() — students don't need the raw
// recurring rule, only computed open slots via GET /bookings/open-slots.
router.get('/', requireRole('elle'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, day_of_week, start_time, end_time FROM availability ORDER BY day_of_week ASC, start_time ASC'
    );

    res.status(200).json({ availability: rows.map(serializeAvailability) });
  } catch (err) {
    next(err);
  }
});

router.delete(
  '/:id',
  requireRole('elle'),
  validateParams(availabilityIdParamSchema),
  async (req, res, next) => {
    try {
      const [result] = await pool.query('DELETE FROM availability WHERE id = ?', [req.params.id]);

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
  requireRole('elle'),
  validateParams(availabilityIdParamSchema),
  validateBody(createAvailabilitySchema),
  async (req, res, next) => {
    try {
      const { day_of_week, start_time, end_time } = req.body;

      let result;
      try {
        [result] = await pool.query(
          'UPDATE availability SET day_of_week = ?, start_time = ?, end_time = ? WHERE id = ?',
          [day_of_week, start_time, end_time, req.params.id]
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

      const [rows] = await pool.query('SELECT * FROM availability WHERE id = ?', [req.params.id]);

      res.status(200).json({ availability: serializeAvailability(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
