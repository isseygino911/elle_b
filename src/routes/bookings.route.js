const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  createBookingSchema,
  openSlotsQuerySchema,
  listBookingsQuerySchema,
  bookingIdParamSchema,
  cancelBookingSchema
} = require('../schemas/bookings.schema');
const {
  toMysqlDatetime,
  computeOpenSlots,
  fetchScopedBookings,
  serializeBooking
} = require('./bookings.helpers');
const { getElleUserId } = require('../utils/elleUser');
const { insertNotification } = require('./notifications.helpers');
const { studentExists } = require('../utils/students');
const { getEasternDateParts } = require('../utils/timezone');

const router = express.Router();

// Re-selects a single booking row (joined with the student's users row),
// with scheduled_at requested as a raw string — see bookings.helpers.js's
// header comment for why this dateStrings scoping is required on every
// query that touches scheduled_at.
async function loadBookingRow(executor, id) {
  const [rows] = await executor.query(
    {
      sql: `SELECT b.*, u.name AS student_name
            FROM bookings b
            JOIN users u ON u.id = b.student_id
            WHERE b.id = ?`,
      dateStrings: ['DATETIME']
    },
    [id]
  );
  return rows[0];
}

router.get(
  '/open-slots',
  requireAuth(),
  validateQuery(openSlotsQuerySchema),
  async (req, res, next) => {
    try {
      const slots = await computeOpenSlots(pool, req.query.date);

      res.status(200).json({ date: req.query.date, slots });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/', requireAuth(), validateBody(createBookingSchema), async (req, res, next) => {
  try {
    // zod's .datetime() accepts any sub-second precision (including none),
    // but computeOpenSlots always generates candidate slots in canonical
    // "...000Z" form. Normalize via round-tripping through Date so the
    // string comparison against computeOpenSlots's output below is exact
    // regardless of the precision the client actually sent.
    const scheduled_at = new Date(req.body.scheduled_at).toISOString();

    let studentId;
    if (req.user.role === 'student') {
      studentId = req.user.id;
    } else {
      studentId = req.body.student_id;
      if (studentId === undefined || studentId === null) {
        return res.status(400).json({ status: 'error', message: 'student_id is required when booking on behalf of a student' });
      }
      if (!(await studentExists(studentId))) {
        return res.status(400).json({ status: 'error', message: 'student_id does not reference an existing student' });
      }
    }

    // computeOpenSlots's `date` parameter means an America/New_York calendar
    // date, not a UTC one -- derive it from the UTC instant accordingly
    // (see utils/timezone.js).
    const { year, month, day } = getEasternDateParts(new Date(scheduled_at));
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const connection = await pool.getConnection();
    let bookingId;

    try {
      await connection.beginTransaction();

      const openSlots = await computeOpenSlots(connection, date);
      if (!openSlots.includes(scheduled_at)) {
        await connection.rollback();
        return res.status(409).json({ status: 'error', message: 'Requested slot is not open' });
      }

      const jitsiRoomId = crypto.randomUUID();

      let insertResult;
      try {
        [insertResult] = await connection.query(
          'INSERT INTO bookings (student_id, scheduled_at, duration_min, jitsi_room_id) VALUES (?, ?, 30, ?)',
          [studentId, toMysqlDatetime(scheduled_at), jitsiRoomId]
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          await connection.rollback();
          return res.status(409).json({ status: 'error', message: 'That slot was just booked, please choose another' });
        }
        throw err;
      }
      bookingId = insertResult.insertId;

      const recipientId = req.user.role === 'elle' ? studentId : await getElleUserId(connection);
      if (recipientId) {
        await insertNotification(connection, { userId: recipientId, type: 'booking', refId: bookingId });
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      return next(err);
    } finally {
      connection.release();
    }

    const row = await loadBookingRow(pool, bookingId);

    res.status(201).json({ booking: serializeBooking(row) });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth(), validateQuery(listBookingsQuerySchema), async (req, res, next) => {
  try {
    const rows = await fetchScopedBookings(req.user, req.query);

    res.status(200).json({ bookings: rows.map(serializeBooking) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id',
  requireAuth(),
  validateParams(bookingIdParamSchema),
  validateBody(cancelBookingSchema),
  async (req, res, next) => {
    try {
      const connection = await pool.getConnection();
      let row;

      try {
        await connection.beginTransaction();

        const [result] = await connection.query(
          "UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'booked' AND (? = 'elle' OR student_id = ?)",
          [req.params.id, req.user.role, req.user.id]
        );

        if (result.affectedRows === 0) {
          await connection.rollback();
          return res.status(404).json({ status: 'error', message: 'Booking not found' });
        }

        row = await loadBookingRow(connection, req.params.id);

        const recipientId =
          req.user.role === 'elle' ? row.student_id : await getElleUserId(connection);
        if (recipientId) {
          await insertNotification(connection, { userId: recipientId, type: 'booking', refId: req.params.id });
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      res.status(200).json({ booking: serializeBooking(row) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
