'use strict';

// BUG G -- cross-organization notifications.
//
// insertNotification (notifications.helpers.js) performs no validation at all:
// it writes whatever (orgId, userId) pair it is handed. Every call site passes
// orgId: req.user.orgId -- the ACTOR's org -- while userId comes from
// resolveCounterparty, which for a student actor returns actor.adminId
// straight off the JWT with no org check, and falls back to a DB lookup whose
// query has no org_id predicate either.
//
// The notifications table has an FK on user_id and an FK on org_id, but no
// composite constraint tying the two together, so (org A, user in org B) is a
// valid row at the database level.
//
// The read path compounds it: notifications.route.js filters on user_id alone
// and ignores org_id entirely, so a row landing on the wrong user IS returned
// to them.
//
// Commit 0e0255c added student reassignment -- the feature that can move a
// student's admin_id -- without touching counterparty.js. These tests fix the
// boundary before that becomes reachable.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { post, get } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

test('a notification is never written for a recipient outside the actor org', async () => {
  const { orgA, orgB } = ctx.fixtures;

  // The attack shape: a student in org A holding a token whose `adm` claim
  // points at a teacher in org B. The login path would never mint this, but a
  // stale token after a cross-org reassignment is exactly this shape, and the
  // JWT is trusted without a re-read.
  const forgedToken = tokenFor(orgA.student1a, { adminId: orgB.teacher.id });

  await post(`/messages/${orgA.student1a.id}`, {
    token: forgedToken,
    body: { body: 'hello from the wrong org' }
  });

  // Whatever the endpoint returned, no notification may exist naming a
  // recipient outside the row's own organization.
  const [rows] = await ctx.pool.query(
    `SELECT n.id, n.org_id, n.user_id, u.org_id AS recipient_org
       FROM notifications n
       JOIN users u ON u.id = n.user_id
      WHERE n.org_id <> u.org_id`
  );

  assert.deepEqual(rows, [], 'found notification rows whose org_id differs from the recipient org');
});

test('the org B teacher receives nothing from an org A action', async () => {
  const { orgA, orgB } = ctx.fixtures;

  const forgedToken = tokenFor(orgA.student1a, { adminId: orgB.teacher.id });
  await post(`/messages/${orgA.student1a.id}`, {
    token: forgedToken,
    body: { body: 'hello' }
  });

  const res = await get('/notifications', { token: tokenFor(orgB.teacher) });

  assert.equal(res.status, 200);
  assert.equal(
    res.body.notifications.length,
    0,
    'a teacher in another organization was notified of an action they cannot see'
  );
});

test('the read path does not return a cross-org row even if one exists', async () => {
  const { orgA, orgB } = ctx.fixtures;

  // Write the bad row directly, bypassing the route, to test the READ fence
  // independently of the write fence. Defence in depth: with BUG G fixed this
  // row cannot be created through the app, but the reader should not depend on
  // that being true.
  await ctx.pool.query(
    'INSERT INTO notifications (org_id, user_id, type, ref_id, title) VALUES (?, ?, ?, ?, ?)',
    [orgA.id, orgB.teacher.id, 'message', 1, 'leaked across orgs']
  );

  const res = await get('/notifications', { token: tokenFor(orgB.teacher) });

  assert.equal(res.status, 200);
  assert.equal(
    res.body.notifications.length,
    0,
    'read path returned a notification whose org_id does not match the caller org'
  );
});

test('normal same-org notification still works', async () => {
  const { orgA } = ctx.fixtures;

  // The fence must not be so tight that it breaks the ordinary case.
  const res = await post(`/messages/${orgA.student1a.id}`, {
    token: tokenFor(orgA.student1a),
    body: { body: 'hello my teacher' }
  });

  assert.equal(res.status, 201);

  const teacherView = await get('/notifications', { token: tokenFor(orgA.teacher1) });
  assert.equal(teacherView.body.notifications.length, 1);
  assert.equal(teacherView.body.notifications[0].type, 'message');
});
