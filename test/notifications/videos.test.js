'use strict';

// Phase 2 -- video_uploaded and video_reviewed.
//
// video_uploaded is the biggest functional gap in the whole notification
// system: a student uploads a practice video and their teacher is told
// nothing. videos.route.js does not import the notification helpers at all.
//
// video_reviewed is the mirror: comments.route.js already flips
// pending_review -> reviewed when a teacher comments, but the student is never
// told their work was looked at.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { post } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

// POST /videos calls s3.headVideoObject to confirm the client really uploaded
// the object before recording a row. That is a genuine network call to S3, so
// it is stubbed here.
//
// Stubbing the module export object (rather than injecting a fake) keeps
// production code free of test seams: src/services/s3.js exports a plain
// object, and the route holds a reference to that same object, so replacing a
// key on it is visible to the route immediately. Restored in afterEach so one
// test's stub cannot leak into another's.
let s3;
let realHead;

function stubHeadObject(result) {
  // eslint-disable-next-line global-require
  s3 = s3 || require('../../src/services/s3');
  if (!realHead) {
    realHead = s3.headVideoObject;
  }
  s3.headVideoObject = async () => result;
}

test.afterEach(() => {
  if (s3 && realHead) {
    s3.headVideoObject = realHead;
  }
});

// Matches what the route accepts: an allowed content type and a size under the
// cap. See src/constants/video.js.
const GOOD_HEAD = { contentType: 'video/mp4', contentLength: 1024 };

async function notificationsFor(userId) {
  const [rows] = await ctx.pool.query(
    'SELECT type, ref_id, actor_id, title FROM notifications WHERE user_id = ? ORDER BY id ASC',
    [userId]
  );
  return rows;
}

async function uploadPracticeVideo(actor, { title = 'My practice run' } = {}) {
  stubHeadObject(GOOD_HEAD);

  return post('/videos', {
    token: tokenFor(actor),
    body: {
      type: 'practice',
      title,
      // Unique per call: videos.s3_key is UNIQUE, and a duplicate returns 409
      // rather than the 201 these tests assert on.
      s3_key: `videos/${actor.id}-${title.replace(/\W+/g, '-')}/clip.mp4`,
      duration_sec: 90
    }
  });
}

test('a student uploading a practice video notifies their teacher', async () => {
  const { orgA } = ctx.fixtures;

  const created = await uploadPracticeVideo(orgA.student1a);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const rows = await notificationsFor(orgA.teacher1.id);
  assert.equal(rows.length, 1, 'the teacher must learn a video is waiting');
  assert.equal(rows[0].type, 'video_uploaded');
  assert.equal(Number(rows[0].ref_id), Number(created.body.video.id));
  assert.equal(rows[0].actor_id, orgA.student1a.id);

  // Nobody else in the org hears about it -- not the peer teacher, not the
  // owner. A practice video is per-student detail.
  const peer = await notificationsFor(orgA.teacher2.id);
  assert.deepEqual(peer, [], 'a peer teacher is not a party to this');
});

test('an unassigned student uploading a video notifies nobody but still succeeds', async () => {
  const { orgA } = ctx.fixtures;

  // orphanStudent has admin_id NULL. Unlike messages -- where the thread row
  // itself cannot be written without a teacher -- a video is a standalone
  // record and uploading it is legitimate. The upload succeeds; there is simply
  // nobody to tell.
  const created = await uploadPracticeVideo(orgA.orphanStudent);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, [], 'no teacher means no recipient, not an error');
});

test('a teacher commenting marks the video reviewed and tells the student', async () => {
  const { orgA } = ctx.fixtures;

  const created = await uploadPracticeVideo(orgA.student1a);
  const videoId = created.body.video.id;

  // Drop the video_uploaded row so this test asserts only on the comment.
  await ctx.pool.query('DELETE FROM notifications');

  const commented = await post(`/videos/${videoId}/comments`, {
    token: tokenFor(orgA.teacher1),
    body: { body: 'Lovely tone in the second phrase.' }
  });
  assert.equal(commented.status, 201, JSON.stringify(commented.body));
  assert.equal(commented.body.video.status, 'reviewed');

  const rows = await notificationsFor(orgA.student1a.id);
  const types = rows.map((row) => row.type);

  // Two distinct facts, deliberately two rows: somebody commented, and the
  // video moved out of the review queue. Collapsing them would lose the
  // status change on any future comment that is not the first.
  assert.deepEqual(
    types.sort(),
    ['comment', 'video_reviewed'],
    'the student learns both that there is feedback and that review is done'
  );

  const reviewed = rows.find((row) => row.type === 'video_reviewed');
  assert.equal(Number(reviewed.ref_id), Number(videoId));
  assert.equal(reviewed.actor_id, orgA.teacher1.id);
});

test('a second teacher comment does not re-fire video_reviewed', async () => {
  const { orgA } = ctx.fixtures;

  const created = await uploadPracticeVideo(orgA.student1a);
  const videoId = created.body.video.id;

  await post(`/videos/${videoId}/comments`, {
    token: tokenFor(orgA.teacher1),
    body: { body: 'First pass.' }
  });
  await ctx.pool.query('DELETE FROM notifications');

  // The video is already 'reviewed', so the UPDATE's `AND status =
  // 'pending_review'` guard matches nothing. The notification must follow the
  // same guard, or every subsequent comment claims a fresh review.
  await post(`/videos/${videoId}/comments`, {
    token: tokenFor(orgA.teacher1),
    body: { body: 'One more thought.' }
  });

  const rows = await notificationsFor(orgA.student1a.id);
  const types = rows.map((row) => row.type);

  assert.deepEqual(types, ['comment'], 'review happens once, comments repeat');
});

test('a student commenting on their own video does not mark it reviewed', async () => {
  const { orgA } = ctx.fixtures;

  const created = await uploadPracticeVideo(orgA.student1a);
  const videoId = created.body.video.id;
  await ctx.pool.query('DELETE FROM notifications');

  const commented = await post(`/videos/${videoId}/comments`, {
    token: tokenFor(orgA.student1a),
    body: { body: 'I struggled with the shift here.' }
  });
  assert.equal(commented.status, 201, JSON.stringify(commented.body));
  assert.equal(commented.body.video.status, 'pending_review');

  const rows = await notificationsFor(orgA.teacher1.id);
  const types = rows.map((row) => row.type);

  assert.deepEqual(types, ['comment'], 'a student cannot review their own work');
});
