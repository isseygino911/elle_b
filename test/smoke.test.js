'use strict';

// Proves the harness itself works end to end, before any feature test relies
// on it: scratch schema, migrations, fixtures, a running app, and auth.
//
// It also asserts the safety guards FIRE. A guard nobody has watched refuse
// something is not yet a guard -- it is an untested branch that happens to sit
// between the test suite and a production database.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTestDatabase } = require('./helpers/setup');
const { get } = require('./helpers/app');
const { tokenFor } = require('./helpers/auth');
const { assertDisposableSchemaName, ALLOWED_HOSTS } = require('./helpers/env');
const { getSchemaName } = require('./helpers/db');

const { ctx } = useTestDatabase();

test('harness: connects to a disposable elle_test_ schema, never production', async () => {
  const [rows] = await ctx.pool.query('SELECT DATABASE() AS db');
  const live = rows[0].db;

  assert.match(live, /^elle_test_\d+$/, `connected schema was ${live}`);
  assert.equal(live, getSchemaName());
  assert.notEqual(live, 'u553161013_elle_project');
});

test('harness: migrations applied to the scratch schema', async () => {
  const [rows] = await ctx.pool.query(
    "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'"
  );
  assert.ok(rows[0].c >= 18, `expected the full schema, found ${rows[0].c} tables`);

  const [applied] = await ctx.pool.query('SELECT COUNT(*) AS c FROM schema_migrations');
  assert.ok(applied[0].c >= 25, `expected >=25 migrations applied, found ${applied[0].c}`);
});

test('guard: refuses a schema name that is not disposable', () => {
  // The real production name. This is the exact string the guard exists to
  // reject.
  assert.throws(
    () => assertDisposableSchemaName('u553161013_elle_project'),
    /not a disposable test schema/
  );
});

test('guard: only loopback hosts are allowed', () => {
  assert.ok(!ALLOWED_HOSTS.has('srv1900.hstgr.io'));
  assert.ok(ALLOWED_HOSTS.has('127.0.0.1'));
});

test('fixtures: two orgs seeded with the full role matrix', async () => {
  const { orgA, orgB } = ctx.fixtures;

  assert.notEqual(orgA.id, orgB.id);
  assert.equal(orgA.owner.role, 'owner');
  assert.equal(orgA.manager.role, 'manager');
  assert.equal(orgA.teacher1.role, 'admin');

  // teacher1 owns two students; teacher2 owns one. A scope bug that returns
  // "all students in org" rather than "my students" is only visible because a
  // peer teacher's student exists to be wrongly included.
  assert.equal(orgA.student1a.adminId, orgA.teacher1.id);
  assert.equal(orgA.student1b.adminId, orgA.teacher1.id);
  assert.equal(orgA.student2a.adminId, orgA.teacher2.id);

  // The unassigned student -- the case notifications silently drop (BUG C).
  assert.equal(orgA.orphanStudent.adminId, null);

  // Org B is the far side of every tenancy fence.
  assert.equal(orgB.student.adminId, orgB.teacher.id);
  assert.notEqual(orgB.student.orgId, orgA.teacher1.id);
});

test('fixtures: reseeded between tests, so ids do not leak across cases', async () => {
  const [rows] = await ctx.pool.query('SELECT COUNT(*) AS c FROM users');
  // 8 in org A + 3 in org B. A stale row from the previous test would push
  // this over.
  assert.equal(rows[0].c, 11);
});

test('app: health endpoint responds', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
});

test('app: authenticated route accepts a minted token', async () => {
  const res = await get('/notifications', { token: tokenFor(ctx.fixtures.orgA.teacher1) });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.notifications));
  assert.equal(res.body.unread_count, 0);
});

test('app: rejects a request with no token', async () => {
  const res = await get('/notifications');
  assert.equal(res.status, 401);
});

test('app: rejects a token with no org claim (pre-multi-tenant shape)', async () => {
  // signAccessToken always sets org, so this constructs the stale shape the
  // middleware explicitly guards against.
  const stale = tokenFor(ctx.fixtures.orgA.teacher1, { orgId: null });
  const res = await get('/notifications', { token: stale });

  assert.equal(res.status, 401);
  assert.match(res.body.message, /Session out of date/);
});
