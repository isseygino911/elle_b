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
  findOverlappingBooking,
  fetchScopedBookings,
  serializeBooking
} = require('./bookings.helpers');
const { resolveRecipients } = require('../utils/counterparty');
const { insertNotification } = require('./notifications.helpers');
const { assertStudentInScope } = require('../utils/students');
const { scopeFor } = require('../utils/scope');
const { resolveCalendarAdminId } = require('../utils/calendarAdmin');
const { ROLES } = require('../constants/roles');
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
      // Whose calendar are we showing? A student sees their own teacher's; a
      // teacher sees their own; an owner must name one with ?admin_id=, which
      // is validated to belong to their organization. A manager is rejected --
      // scheduling is per-student detail.
      const adminId = await resolveCalendarAdminId(req, res);
      if (!adminId) {
        return;
      }

      const slots = await computeOpenSlots(pool, req.query.date, adminId);

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

    // adminId is the teacher whose calendar this booking occupies. It is
    // ALWAYS derived from the resolved student, never taken from the request
    // body -- a client-supplied admin_id would let a caller book time on a
    // teacher who is not theirs.
    let studentId;
    let adminId;

    if (req.user.role === ROLES.STUDENT) {
      studentId = req.user.id;
      adminId = req.user.adminId;

      if (!adminId) {
        return res.status(400).json({ status: 'error', message: 'You are not assigned to a teacher yet' });
      }
    } else {
      studentId = req.body.student_id;
      if (studentId === undefined || studentId === null) {
        return res.status(400).json({ status: 'error', message: 'student_id is required when booking on behalf of a student' });
      }

      // Scoped, not a bare existence check: an admin booking "on behalf of"
      // a student must be booking for one of their OWN students, and never
      // for another organization's.
      const student = await assertStudentInScope(req.user, studentId);
      if (!student) {
        return res.status(400).json({ status: 'error', message: 'student_id does not reference an existing student' });
      }

      adminId = student.admin_id;
      if (!adminId) {
        return res.status(400).json({ status: 'error', message: 'That student is not assigned to a teacher yet' });
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

      const openSlots = await computeOpenSlots(connection, date, adminId);
      if (!openSlots.includes(scheduled_at)) {
        await connection.rollback();
        return res.status(409).json({ status: 'error', message: 'Requested slot is not open' });
      }

      // Interval overlap, which the unique index cannot express (see
      // findOverlappingBooking). FOR UPDATE inside this transaction is what
      // makes two simultaneous requests for the same teacher serialize instead
      // of racing.
      const overlapping = await findOverlappingBooking(connection, {
        adminId,
        startIsoUtc: scheduled_at,
        durationMin: 30
      });

      if (overlapping) {
        await connection.rollback();
        return res.status(409).json({ status: 'error', message: 'That slot was just booked, please choose another' });
      }

      const jitsiRoomId = crypto.randomUUID();

      let insertResult;
      try {
        [insertResult] = await connection.query(
          `INSERT INTO bookings (org_id, admin_id, student_id, scheduled_at, duration_min, jitsi_room_id)
           VALUES (?, ?, ?, ?, 30, ?)`,
          [req.user.orgId, adminId, studentId, toMysqlDatetime(scheduled_at), jitsiRoomId]
        );
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          await connection.rollback();
          return res.status(409).json({ status: 'error', message: 'That slot was just booked, please choose another' });
        }
        throw err;
      }
      bookingId = insertResult.insertId;

      const recipients = await resolveRecipients(connection, { actor: req.user, studentId });
      for (const userId of recipients) {
        await insertNotification(connection, {
          orgId: req.user.orgId,
          userId,
          actorId: req.user.id,
          type: 'booking_created',
          title: 'Lesson scheduled',
          body: null,
          refId: bookingId
        });
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

        // Previously: "... AND (? = 'elle' OR student_id = ?)" with the
        // caller's role bound as a SQL string. That is the same
        // negative-scoping trap as elsewhere, expressed in SQL rather than JS:
        // any role that was not the literal string 'elle' fell through to the
        // student check, and any role that WAS 'elle' could cancel every
        // booking in the table. With multiple teachers and organizations, that
        // would let one teacher cancel another's sessions.
        //
        // scopeFor pins the predicate to the caller: an admin can cancel only
        // bookings on their own calendar, an owner only within their own
        // organization, a student only their own booking.
        const scope = scopeFor(req.user, {
          org: 'org_id',
          admin: 'admin_id',
          student: 'student_id'
        });

        const [result] = await connection.query(
          `UPDATE bookings SET status = 'cancelled'
            WHERE id = ? AND status = 'booked' AND ${scope.sql}`,
          [req.params.id, ...scope.params]
        );

        if (result.affectedRows === 0) {
          await connection.rollback();
          return res.status(404).json({ status: 'error', message: 'Booking not found' });
        }

        row = await loadBookingRow(connection, req.params.id);

        const recipients = await resolveRecipients(connection, {
          actor: req.user,
          studentId: row.student_id
        });
        for (const userId of recipients) {
          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId,
            actorId: req.user.id,
            type: 'booking_cancelled',
            title: 'Lesson cancelled',
            body: null,
            // Number(), not req.params.id: every other call site passes a
            // numeric insertId, and this one passed the raw string from the
            // URL. MySQL coerced it so no data was corrupted, but the
            // inconsistency meant ref_id's JS type depended on which event
            // produced the row.
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

      res.status(200).json({ booking: serializeBooking(row) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
