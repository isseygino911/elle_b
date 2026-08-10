const express = require('express');
const pool = require('../db/pool');
const { requireCapability } = require('../middleware/auth');
const { CAN_READ_STUDENT_DETAIL } = require('../constants/roles');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const {
  createAvailabilityExceptionSchema,
  listAvailabilityExceptionsQuerySchema,
  availabilityExceptionIdParamSchema
} = require('../schemas/availabilityExceptions.schema');
const { resolveCalendarAdminId } = require('../utils/calendarAdmin');
const { formatDateOnly } = require('./tasks.helpers');

const router = express.Router();

// A SIBLING path to /availability, not /availability/exceptions. Mounting it
// under the existing router would collide with that router's DELETE /:id and
// PATCH /:id: Express matches in declaration order, and availabilityIdParamSchema's
// /^\d+$/ would 400 on the literal "exceptions" before any sub-route ran.
//
// Dated amendments to the RECURRING availability template (migration 0035).
// A 'block' narrows what is offered on one date; an 'add' offers time the
// weekly template does not. Neither touches the recurrence, and neither ever
// mutates a booking -- see the migration header.

// Shapes an `availability_exceptions` row for API responses.
//
// TIME columns come back from mysql2 as plain "HH:MM:SS" strings (or null), so
// they need no conversion -- same as serializeAvailability. `date` is a DATE
// column and DOES need formatDateOnly: these queries deliberately do not set
// `dateStrings` (unlike the range query in bookings.helpers.js), so mysql2
// hands back a Date built at local midnight, and toISOString() would shift it
// a day at any positive UTC offset. Reusing tasks.helpers.js's formatDateOnly
// rather than writing a second one -- a second implementation is a second
// chance to reintroduce the shift it exists to avoid.
function serializeAvailabilityException(row) {
  return {
    id: row.id,
    date: formatDateOnly(row.date),
    type: row.type,
    start_time: row.start_time,
    end_time: row.end_time
  };
}

router.post(
  '/',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateBody(createAvailabilityExceptionSchema),
  async (req, res, next) => {
    try {
      const { date, type, start_time, end_time } = req.body;

      // admin_id, not org_id: an exception is one specific teacher's dated
      // amendment to their own schedule (see migration 0035). An owner acts on
      // behalf of a named teacher; binding req.user.id here would file the row
      // under the owner's own id, where computeOpenSlotsRange -- which always
      // queries a real teacher's id -- would never read it back.
      const adminId = await resolveCalendarAdminId(req, res);
      if (adminId === null) {
        return;
      }

      let result;
      try {
        [result] = await pool.query(
          'INSERT INTO availability_exceptions (admin_id, date, type, start_time, end_time) VALUES (?, ?, ?, ?, ?)',
          [adminId, date, type, start_time ?? null, end_time ?? null]
        );
      } catch (err) {
        // The zod refinements should catch every one of these first; this is
        // the backstop that turns a 500 into a 400 if the two ever diverge.
        if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
          return res
            .status(400)
            .json({ status: 'error', message: 'Invalid availability exception times' });
        }
        throw err;
      }

      const [rows] = await pool.query('SELECT * FROM availability_exceptions WHERE id = ?', [
        result.insertId
      ]);

      res.status(201).json({ exception: serializeAvailabilityException(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

// requireCapability(CAN_READ_STUDENT_DETAIL), not requireAuth() — students
// don't need the raw amendments, only the computed open slots that already
// account for them (GET /bookings/open-slots and .../open-slots-range).
router.get(
  '/',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateQuery(listAvailabilityExceptionsQuerySchema),
  async (req, res, next) => {
    try {
      const adminId = await resolveCalendarAdminId(req, res);
      if (adminId === null) {
        return;
      }

      const { from, to } = req.query;

      // No result cap: this is a raw-row listing for one teacher's own
      // management UI, bounded by how many exceptions they have created, not
      // by any date arithmetic the client controls. (Contrast the range
      // endpoint, whose span IS client-controlled and therefore capped.)
      const conditions = ['admin_id = ?'];
      const params = [adminId];
      if (from && to) {
        conditions.push('date BETWEEN ? AND ?');
        params.push(from, to);
      }

      // start_time is nullable and MySQL sorts NULL first, so a whole-day
      // block sorts ahead of that day's partial blocks -- the right reading
      // order.
      const [rows] = await pool.query(
        `SELECT id, date, type, start_time, end_time FROM availability_exceptions
          WHERE ${conditions.join(' AND ')}
          ORDER BY date ASC, start_time ASC`,
        params
      );

      res.status(200).json({ exceptions: rows.map(serializeAvailabilityException) });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateParams(availabilityExceptionIdParamSchema),
  validateBody(createAvailabilityExceptionSchema),
  async (req, res, next) => {
    try {
      const { date, type, start_time, end_time } = req.body;

      const adminId = await resolveCalendarAdminId(req, res);
      if (adminId === null) {
        return;
      }

      let result;
      try {
        // admin_id in the predicate, not just the id — see the DELETE below.
        [result] = await pool.query(
          'UPDATE availability_exceptions SET date = ?, type = ?, start_time = ?, end_time = ? WHERE id = ? AND admin_id = ?',
          [date, type, start_time ?? null, end_time ?? null, req.params.id, adminId]
        );
      } catch (err) {
        if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
          return res
            .status(400)
            .json({ status: 'error', message: 'Invalid availability exception times' });
        }
        throw err;
      }

      if (result.affectedRows === 0) {
        return res
          .status(404)
          .json({ status: 'error', message: 'Availability exception not found' });
      }

      const [rows] = await pool.query(
        'SELECT * FROM availability_exceptions WHERE id = ? AND admin_id = ?',
        [req.params.id, adminId]
      );

      res.status(200).json({ exception: serializeAvailabilityException(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:id',
  requireCapability(CAN_READ_STUDENT_DETAIL),
  validateParams(availabilityExceptionIdParamSchema),
  async (req, res, next) => {
    try {
      const adminId = await resolveCalendarAdminId(req, res);
      if (adminId === null) {
        return;
      }

      // admin_id in the predicate, not just the id: without it one teacher
      // could delete another teacher's exception by guessing a row id.
      // resolveCalendarAdminId already pins an ADMIN to their own id, but an
      // OWNER's adminId comes from a request field -- validated to be a teacher
      // in their org, but still possibly a different teacher than the row's
      // owner. Returning 404 (rather than 403) on zero rows also means a
      // wrong-owner id is indistinguishable from a nonexistent one: no
      // existence oracle.
      const [result] = await pool.query(
        'DELETE FROM availability_exceptions WHERE id = ? AND admin_id = ?',
        [req.params.id, adminId]
      );

      if (result.affectedRows === 0) {
        return res
          .status(404)
          .json({ status: 'error', message: 'Availability exception not found' });
      }

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
