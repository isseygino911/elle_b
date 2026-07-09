// Shared helpers used by both videos.route.js and comments.route.js, so the
// video access-control predicate lives in exactly one place.

const pool = require('../db/pool');

// Shapes a `videos` row for API responses — omits the internal s3_key
// (playback goes through the dedicated /playback-url endpoint instead).
function serializeVideo(row) {
  return {
    id: row.id,
    type: row.type,
    student_id: row.student_id,
    title: row.title,
    duration_sec: row.duration_sec,
    status: row.status,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at
  };
}

// Shared by GET /:id and GET /:id/playback-url (and comments.route.js): loads
// the video and applies the "student can only see their own" access rule. A
// student who doesn't own the video gets a 404 (not 403) so existence isn't
// confirmed to them. Returns the video row, or null after already sending the
// response.
async function loadAuthorizedVideo(req, res) {
  const [rows] = await pool.query('SELECT * FROM videos WHERE id = ?', [req.params.id]);
  const video = rows[0];

  if (!video || (req.user.role === 'student' && video.student_id !== req.user.id)) {
    res.status(404).json({ status: 'error', message: 'Video not found' });
    return null;
  }

  return video;
}

module.exports = { serializeVideo, loadAuthorizedVideo };
