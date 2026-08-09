'use strict';

// Phase 3 -- broadcast.
//
// The permission model here is the whole feature. Sending an announcement is
// easy; the reason this file is long is that broadcast is the first thing in
// the app where one action deliberately touches MANY users' records at once,
// and that is exactly the shape a privacy bug likes.
//
// Three boundaries are asserted, each of which the plan names as
// must-not-regress:
//   1. A manager cannot send. They outrank an admin who can, so any rank-based
//      gate passes them -- this is the canonical wrong-check test.
//   2. A teacher cannot reach another teacher's students, however they set the
//      audience field.
//   3. The manager's oversight copy contains no student identity and no
//      message body IN THE RAW JSON -- not merely in the rendered UI.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('../helpers/setup');
const { get, post } = require('../helpers/app');
const { tokenFor } = require('../helpers/auth');

const { ctx } = useTestDatabase();

async function notificationsFor(userId) {
  const [rows] = await ctx.pool.query(
    'SELECT type, ref_id, actor_id, title, body FROM notifications WHERE user_id = ? ORDER BY id ASC',
    [userId]
  );
  return rows;
}

async function broadcastRows() {
  const [rows] = await ctx.pool.query('SELECT * FROM broadcasts ORDER BY id ASC');
  return rows;
}

// ---------------------------------------------------------------------------
// Owner: org-wide reach
// ---------------------------------------------------------------------------

test('owner broadcasting to students notifies every student in the org', async () => {
  const { orgA, orgB } = ctx.fixtures;

  const sent = await post('/broadcasts', {
    token: tokenFor(orgA.owner),
    body: { audience: 'students', title: 'Recital on Friday', body: 'Doors at 6pm.' }
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  // Four students in org A: student1a, student1b, student2a, orphanStudent.
  // orphanStudent is included deliberately -- having no teacher does not make
  // someone unreachable by their own organization's owner. This is the case
  // every OTHER notification in the app drops (BUG C), and broadcast is the
  // one event where dropping it would be wrong.
  assert.equal(sent.body.broadcast.recipient_count, 4);

  for (const student of [orgA.student1a, orgA.student1b, orgA.student2a, orgA.orphanStudent]) {
    const rows = await notificationsFor(student.id);
    assert.equal(rows.length, 1, `student ${student.id} must receive the broadcast`);
    assert.equal(rows[0].type, 'broadcast');
    assert.equal(rows[0].title, 'Recital on Friday');
    assert.equal(rows[0].body, 'Doors at 6pm.');
    assert.equal(rows[0].actor_id, orgA.owner.id);
    assert.equal(Number(rows[0].ref_id), Number(sent.body.broadcast.id));
  }

  // Audience was 'students'. Teachers are not students.
  assert.equal((await notificationsFor(orgA.teacher1.id)).length, 0);
  assert.equal((await notificationsFor(orgA.manager.id)).length, 0);

  // The tenancy fence. Org B's student is a student, and would be swept up by
  // any recipient query missing its org_id predicate.
  assert.equal((await notificationsFor(orgB.student.id)).length, 0);
});

test("owner broadcasting to 'both' reaches teachers and students, but not managers", async () => {
  const { orgA } = ctx.fixtures;

  const sent = await post('/broadcasts', {
    token: tokenFor(orgA.owner),
    body: { audience: 'both', title: 'Studio closed Monday', body: 'Public holiday.' }
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  // 2 teachers + 4 students. NOT the manager, and NOT the owner themselves.
  //
  // This is the assertion that catches a rank-based recipient query: any
  // "everyone below me" formulation sweeps up the manager (rank 3 < owner's 4),
  // and 'both' would silently become 'everyone'.
  assert.equal(sent.body.broadcast.recipient_count, 6);

  assert.equal((await notificationsFor(orgA.teacher1.id)).length, 1);
  assert.equal((await notificationsFor(orgA.teacher2.id)).length, 1);
  assert.equal((await notificationsFor(orgA.student1a.id)).length, 1);
  assert.equal((await notificationsFor(orgA.manager.id)).length, 0, 'manager is not an audience');
  assert.equal((await notificationsFor(orgA.owner.id)).length, 0, 'sender must not notify themselves');
});

// ---------------------------------------------------------------------------
// Teacher: own roster only
// ---------------------------------------------------------------------------

test("a teacher's broadcast reaches only their own students", async () => {
  const { orgA, orgB } = ctx.fixtures;

  const sent = await post('/broadcasts', {
    token: tokenFor(orgA.teacher1),
    body: { audience: 'students', title: 'Bring your scale book', body: 'Every lesson this month.' }
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  // teacher1 owns exactly student1a and student1b.
  assert.equal(sent.body.broadcast.recipient_count, 2);
  assert.equal((await notificationsFor(orgA.student1a.id)).length, 1);
  assert.equal((await notificationsFor(orgA.student1b.id)).length, 1);

  // The boundary: teacher2's student, and the student with no teacher at all.
  // A roster query that filtered on role but forgot admin_id would catch both.
  assert.equal((await notificationsFor(orgA.student2a.id)).length, 0, "not teacher2's student");
  assert.equal((await notificationsFor(orgA.orphanStudent.id)).length, 0, 'not on any roster');
  assert.equal((await notificationsFor(orgB.student.id)).length, 0, 'not this org');
});

test('a teacher may not address teachers or the whole org', async () => {
  const { orgA } = ctx.fixtures;

  for (const audience of ['teachers', 'both']) {
    const sent = await post('/broadcasts', {
      token: tokenFor(orgA.teacher1),
      body: { audience, title: 'Staff notice', body: 'Should not send.' }
    });

    // 403, not 400: the payload is well-formed and the column would accept the
    // value. What is refused is this sender using it.
    assert.equal(sent.status, 403, `audience=${audience} must be forbidden`);
  }

  assert.deepEqual(await broadcastRows(), [], 'no broadcast row may be written');
  assert.equal((await notificationsFor(orgA.teacher2.id)).length, 0);
});

test('a teacher with no students is refused rather than sending to nobody', async () => {
  const { orgA } = ctx.fixtures;

  // Detach teacher1's roster, leaving them a teacher with zero students.
  await ctx.pool.query('UPDATE users SET admin_id = NULL WHERE admin_id = ?', [orgA.teacher1.id]);

  const sent = await post('/broadcasts', {
    token: tokenFor(orgA.teacher1),
    body: { audience: 'students', title: 'Anyone there?', body: 'Hello.' }
  });

  assert.equal(sent.status, 400, JSON.stringify(sent.body));

  // The transaction must have rolled back completely -- no orphaned row
  // claiming recipient_count = 0 sitting in the teacher's outbox.
  assert.deepEqual(await broadcastRows(), []);
});

// ---------------------------------------------------------------------------
// Manager: cannot send, receives oversight only
// ---------------------------------------------------------------------------

test('a manager cannot broadcast, despite outranking a teacher who can', async () => {
  const { orgA } = ctx.fixtures;

  const sent = await post('/broadcasts', {
    token: tokenFor(orgA.manager),
    body: { audience: 'students', title: 'From the manager', body: 'Should not send.' }
  });

  // The canonical wrong-check test. manager is rank 3, admin is rank 2, so
  // every `rank >= admin` gate lets this through. Only a positive allowlist
  // refuses it.
  assert.equal(sent.status, 403, JSON.stringify(sent.body));
  assert.deepEqual(await broadcastRows(), []);
});

test('a student cannot broadcast', async () => {
  const { orgA } = ctx.fixtures;

  const sent = await post('/broadcasts', {
    token: tokenFor(orgA.student1a),
    body: { audience: 'students', title: 'From a student', body: 'Should not send.' }
  });

  assert.equal(sent.status, 403, JSON.stringify(sent.body));
  assert.deepEqual(await broadcastRows(), []);
});

test('a teacher broadcast sends oversight copies to the owner and managers', async () => {
  const { orgA } = ctx.fixtures;

  const sent = await post('/broadcasts', {
    token: tokenFor(orgA.teacher1),
    body: { audience: 'students', title: 'Bring your scale book', body: 'Private to my students.' }
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  for (const overseer of [orgA.owner, orgA.manager]) {
    const rows = await notificationsFor(overseer.id);
    assert.equal(rows.length, 1, `overseer ${overseer.id} must be told`);
    assert.equal(rows[0].type, 'broadcast');

    // Sender, reach, and subject. The count is the aggregate the manager tier
    // is entitled to.
    assert.match(rows[0].title, /2 students/);
    assert.equal(rows[0].actor_id, orgA.teacher1.id);

    // THE PRIVACY ASSERTION. The oversight copy carries the announcement's
    // subject, never its body -- a manager may see THAT a teacher messaged
    // their roster, not what was said.
    assert.equal(rows[0].body, 'Bring your scale book');
    assert.notEqual(rows[0].body, 'Private to my students.');
  }

  // The other teacher is not an overseer.
  assert.equal((await notificationsFor(orgA.teacher2.id)).length, 0);
});

test('an owner broadcasting org-wide does not also send themselves an oversight copy', async () => {
  const { orgA } = ctx.fixtures;

  const sent = await post('/broadcasts', {
    token: tokenFor(orgA.owner),
    body: { audience: 'both', title: 'Studio closed Monday', body: 'Public holiday.' }
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  // The owner already reached everyone they would be copying. The manager is
  // outside the 'both' audience and gets nothing -- an oversight copy here
  // would be the manager's only notification, which would make 'both' quietly
  // mean 'everyone'.
  assert.equal((await notificationsFor(orgA.owner.id)).length, 0);
  assert.equal((await notificationsFor(orgA.manager.id)).length, 0);
});

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

test('the manager oversight list exposes no message body and no student names', async () => {
  const { orgA } = ctx.fixtures;

  await post('/broadcasts', {
    token: tokenFor(orgA.teacher1),
    body: { audience: 'students', title: 'Bring your scale book', body: 'SECRET-BODY-TEXT' }
  });

  const listed = await get('/broadcasts', { token: tokenFor(orgA.manager) });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.broadcasts.length, 1);

  const row = listed.body.broadcasts[0];
  assert.equal(row.sender_name, 'Teacher One');
  assert.equal(row.recipient_count, 2);
  assert.equal(row.title, 'Bring your scale book');

  // Asserted on the RAW JSON, per the plan: hiding the body in the UI while
  // shipping it in the payload is not a privacy boundary. The serialized
  // object must not carry the key at all.
  assert.equal('body' in row, false, 'manager must not receive the message body');

  const raw = JSON.stringify(listed.body);
  assert.equal(raw.includes('SECRET-BODY-TEXT'), false);
  for (const student of [orgA.student1a, orgA.student1b]) {
    assert.equal(raw.includes(student.name), false, 'no recipient identity may appear');
  }
});

test('a teacher sees only their own sent broadcasts; the owner sees all', async () => {
  const { orgA } = ctx.fixtures;

  await post('/broadcasts', {
    token: tokenFor(orgA.teacher1),
    body: { audience: 'students', title: 'From teacher one', body: 'One.' }
  });
  await post('/broadcasts', {
    token: tokenFor(orgA.teacher2),
    body: { audience: 'students', title: 'From teacher two', body: 'Two.' }
  });

  const asTeacher1 = await get('/broadcasts', { token: tokenFor(orgA.teacher1) });
  assert.equal(asTeacher1.status, 200);
  assert.equal(asTeacher1.body.broadcasts.length, 1, "a teacher's outbox is their own");
  assert.equal(asTeacher1.body.broadcasts[0].title, 'From teacher one');
  // The sender does see their own body -- the oversight redaction must not
  // apply to the person who wrote it.
  assert.equal(asTeacher1.body.broadcasts[0].body, 'One.');

  const asOwner = await get('/broadcasts', { token: tokenFor(orgA.owner) });
  assert.equal(asOwner.body.broadcasts.length, 2, 'the owner sees the whole org');
  assert.equal(asOwner.body.broadcasts[0].body, 'Two.', 'and is not redacted');
});

test('broadcasts are fenced to the org; a student may not list them', async () => {
  const { orgA, orgB } = ctx.fixtures;

  await post('/broadcasts', {
    token: tokenFor(orgA.owner),
    body: { audience: 'students', title: 'Org A only', body: 'Internal.' }
  });

  // Org B's owner is an owner, and would see every broadcast in the table if
  // the list query were not org-fenced.
  const asOwnerB = await get('/broadcasts', { token: tokenFor(orgB.owner) });
  assert.equal(asOwnerB.status, 200);
  assert.deepEqual(asOwnerB.body.broadcasts, []);

  // A student's copy is the notification they already received; the outbox is
  // not theirs to read. 403 rather than an empty list, which would read as
  // "you have sent none".
  const asStudent = await get('/broadcasts', { token: tokenFor(orgA.student1a) });
  assert.equal(asStudent.status, 403);
});

test('title and body are required and bounded', async () => {
  const { orgA } = ctx.fixtures;

  const noBody = await post('/broadcasts', {
    token: tokenFor(orgA.owner),
    body: { audience: 'students', title: 'Subject only', body: '   ' }
  });
  assert.equal(noBody.status, 400, 'an announcement with no message is not a message');

  const badAudience = await post('/broadcasts', {
    token: tokenFor(orgA.owner),
    body: { audience: 'everyone', title: 'Hello', body: 'Hi.' }
  });
  // 400, not 403: 'everyone' is not a value the column can hold, so this is
  // malformed input rather than a permission failure.
  assert.equal(badAudience.status, 400);

  const tooLong = await post('/broadcasts', {
    token: tokenFor(orgA.owner),
    body: { audience: 'students', title: 'x'.repeat(256), body: 'Hi.' }
  });
  assert.equal(tooLong.status, 400, 'title must not exceed the VARCHAR(255) column');

  assert.deepEqual(await broadcastRows(), []);
});
