// Shared helpers used by both videos.route.js and comments.route.js, so the
// video access-control predicate lives in exactly one place.

const pool = require('../db/pool');
const { scopeFor } = require('../utils/scope');

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

// Shared by GET /:id, GET /:id/playback-url and comments.route.js: loads the
// video, scoped to what the caller may actually see.
//
// This used to be `WHERE id = ?` plus a single negative check ("if student,
// must own it"), which meant every OTHER role fell through with no predicate
// at all -- reading any video in any organization. That is exactly the
// negative-scoping shape utils/scope.js was written to abolish, so this now
// goes through scopeFor with the SAME column map as the list endpoint in
// videos.route.js. Sharing it is the point: if the by-id fence and the list
// fence could drift, you'd get videos that appear in a list but 404 when
// opened.
//
// Two different failure modes, deliberately:
//   - owner/admin/student get a predicate; a row outside it is a 404, so ids
//     can't be probed for existence.
//   - manager makes scopeFor THROW ScopeError (403). A manager is
//     aggregates-only, so reaching a per-student endpoint at all is a policy
//     violation worth surfacing, not an id to hide. Every call site wraps in
//     try/catch -> next(err), and ScopeError carries status 403, so this
//     needs no per-site handling.
//
// Returns the video row, or null after already sending the response.
async function loadAuthorizedVideo(req, res) {
  const scope = scopeFor(req.user, {
    org: 'org_id',
    admin: 'admin_id',
    student: 'student_id'
  });

  const [rows] = await pool.query(`SELECT * FROM videos WHERE id = ? AND ${scope.sql}`, [
    req.params.id,
    ...scope.params
  ]);
  const video = rows[0];

  if (!video) {
    res.status(404).json({ status: 'error', message: 'Video not found' });
    return null;
  }

  return video;
}

module.exports = { serializeVideo, loadAuthorizedVideo };
