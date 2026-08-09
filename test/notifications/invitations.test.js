'use strict';

// Phase 2 -- invitation_accepted.
//
// The one event on an UNAUTHENTICATED path. POST /auth/register is public and
// rate-limited; there is no req.user, so both the actor and the organization
// have to come from rows read inside the registration transaction rather than
// from a token.
//
// The recipient is invitations.created_by -- the person who issued the invite,
// which is the only party who was waiting for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { useTestDatabase } = require('../helpers/setup');
const { post } = require('../helpers/app');

const { ctx } = useTestDatabase();

// invitations.token is CHAR(64) ascii and UNIQUE -- a 32-byte hex string is
// exactly 64 characters, matching what invitations.route.js issues.
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function seedInvitation({ orgId, createdBy, role = 'student', status = 'pending', expiresInDays = 7 }) {
  const token = makeToken();

  await ctx.pool.query(
    `INSERT INTO invitations (org_id, token, role, status, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [orgId, token, role, status, createdBy, expiresInDays]
  );

  return token;
}

async function notificationsFor(userId) {
  const [rows] = await ctx.pool.query(
    'SELECT type, ref_id, actor_id, title FROM notifications WHERE user_id = ? ORDER BY id ASC',
    [userId]
  );
  return rows;
}

test('accepting an invitation notifies the teacher who issued it', async () => {
  const { orgA } = ctx.fixtures;

  const token = await seedInvitation({ orgId: orgA.id, createdBy: orgA.teacher1.id });

  const registered = await post('/auth/register', {
    body: {
      token,
      name: 'Newly Joined',
      email: 'newly-joined@test.local',
      password: 'correct horse battery staple'
    }
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));

  const rows = await notificationsFor(orgA.teacher1.id);
  assert.equal(rows.length, 1, 'the inviter must learn their invitation was taken up');
  assert.equal(rows[0].type, 'invitation_accepted');

  // actor_id is the NEW user -- the person who accepted. That is who the
  // notification is about, and it is what lets the read path join their name.
  assert.equal(Number(rows[0].actor_id), Number(registered.body.id));
  assert.match(rows[0].title, /Newly Joined/);
});

test('an invitation issued by an owner notifies that owner', async () => {
  const { orgA } = ctx.fixtures;

  // An owner-issued student invite produces a student with admin_id NULL (the
  // owner chooses a teacher later -- see auth.route.js). The notification still
  // has a clear recipient: the owner who sent it.
  const token = await seedInvitation({ orgId: orgA.id, createdBy: orgA.owner.id });

  const registered = await post('/auth/register', {
    body: {
      token,
      name: 'Owner Invitee',
      email: 'owner-invitee@test.local',
      password: 'correct horse battery staple'
    }
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));

  const rows = await notificationsFor(orgA.owner.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'invitation_accepted');
});

test('a rejected registration writes no notification', async () => {
  const { orgA } = ctx.fixtures;

  // Already used. auth.route.js rolls the whole transaction back, and the
  // notification must roll back with it rather than announcing a registration
  // that did not happen.
  const token = await seedInvitation({
    orgId: orgA.id,
    createdBy: orgA.teacher1.id,
    status: 'used'
  });

  const registered = await post('/auth/register', {
    body: {
      token,
      name: 'Too Late',
      email: 'too-late@test.local',
      password: 'correct horse battery staple'
    }
  });
  assert.equal(registered.status, 400, JSON.stringify(registered.body));

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, [], 'a failed registration announces nothing');
});

test('an expired invitation writes no notification', async () => {
  const { orgA } = ctx.fixtures;

  const token = await seedInvitation({
    orgId: orgA.id,
    createdBy: orgA.teacher1.id,
    expiresInDays: -1
  });

  const registered = await post('/auth/register', {
    body: {
      token,
      name: 'Expired Invitee',
      email: 'expired-invitee@test.local',
      password: 'correct horse battery staple'
    }
  });
  assert.equal(registered.status, 400, JSON.stringify(registered.body));

  const [rows] = await ctx.pool.query('SELECT id FROM notifications');
  assert.deepEqual(rows, []);
});

test('the notification is written against the invitation org, not the inviter row', async () => {
  const { orgA } = ctx.fixtures;

  const token = await seedInvitation({ orgId: orgA.id, createdBy: orgA.teacher1.id });

  await post('/auth/register', {
    body: {
      token,
      name: 'Org Fenced',
      email: 'org-fenced@test.local',
      password: 'correct horse battery staple'
    }
  });

  // insertNotification refuses any (org, recipient) pair that disagrees, so a
  // row landing here at all proves the two were consistent. Asserting org_id
  // explicitly documents WHICH org was chosen as authoritative.
  const [rows] = await ctx.pool.query(
    'SELECT org_id FROM notifications WHERE user_id = ?',
    [orgA.teacher1.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].org_id), Number(orgA.id));
});
