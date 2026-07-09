const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { serializeTask, fetchScopedTasks } = require('./tasks.helpers');
const { serializeBooking, fetchScopedBookings } = require('./bookings.helpers');
const { computeAllStudentsProgress } = require('./students.helpers');

const router = express.Router();

// How many of the least-progressed students to surface in the dashboard
// widget -- a glanceable shortlist, not the full roster (that's what the
// /students section is for).
const STUDENT_PROGRESS_WIDGET_LIMIT = 6;

async function buildTasksSection(user) {
  const rows = await fetchScopedTasks(user, 'pending');
  return { count: rows.length, tasks: rows.map(serializeTask) };
}

async function buildUpcomingBookingsSection(user) {
  const rows = await fetchScopedBookings(user, { status: 'booked', upcoming: true, hoursAhead: 24 });
  return { count: rows.length, bookings: rows.map(serializeBooking) };
}

async function buildElleDashboard(userId) {
  const [videoRows] = await pool.query(
    `SELECT v.id, v.student_id, u.name AS student_name, v.title, v.created_at
     FROM videos v
     JOIN users u ON u.id = v.student_id
     WHERE v.type = 'practice' AND v.status = 'pending_review'
     ORDER BY v.created_at ASC`
  );

  const [messageRows] = await pool.query(
    `SELECT m.student_id, u.name AS student_name, COUNT(*) AS unread_count
     FROM messages m
     JOIN users u ON u.id = m.student_id
     WHERE m.sender_id != ? AND m.read_at IS NULL
     GROUP BY m.student_id, u.name`,
    [userId]
  );

  const totalUnread = messageRows.reduce((sum, row) => sum + row.unread_count, 0);

  const studentProgress = await computeAllStudentsProgress();

  return {
    role: 'elle',
    pending_video_reviews: { count: videoRows.length, videos: videoRows },
    unread_messages: { total_count: totalUnread, by_student: messageRows },
    upcoming_bookings: await buildUpcomingBookingsSection({ id: userId, role: 'elle' }),
    tasks: await buildTasksSection({ id: userId, role: 'elle' }),
    student_progress: {
      total_count: studentProgress.length,
      students: studentProgress.slice(0, STUDENT_PROGRESS_WIDGET_LIMIT)
    }
  };
}

async function buildStudentDashboard(userId) {
  const [videoRows] = await pool.query(
    `SELECT id, title, created_at FROM videos
     WHERE type = 'practice' AND status = 'pending_review' AND student_id = ?
     ORDER BY created_at ASC`,
    [userId]
  );

  const [unreadRows] = await pool.query(
    'SELECT COUNT(*) AS unread_count FROM messages WHERE student_id = ? AND sender_id != ? AND read_at IS NULL',
    [userId, userId]
  );

  return {
    role: 'student',
    pending_video_reviews: { count: videoRows.length, videos: videoRows },
    unread_messages: { count: unreadRows[0].unread_count },
    upcoming_bookings: await buildUpcomingBookingsSection({ id: userId, role: 'student' }),
    tasks: await buildTasksSection({ id: userId, role: 'student' })
  };
}

router.get('/', requireAuth(), async (req, res, next) => {
  try {
    const dashboard =
      req.user.role === 'elle'
        ? await buildElleDashboard(req.user.id)
        : await buildStudentDashboard(req.user.id);

    res.status(200).json(dashboard);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
