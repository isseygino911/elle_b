'use strict';

// One-line lifecycle for a test file:
//
//   const { ctx } = useTestDatabase();
//   test('...', async () => { ctx.pool, ctx.fixtures, ctx.baseUrl });
//
// Creates a scratch schema before the file's first test, reseeds fixtures
// before every test, and drops the schema after the last one.
//
// `ctx` is a stable object mutated in place rather than reassigned, so a test
// body capturing it at module scope still sees the current pool and fixtures.
// Returning fresh values from before() would leave tests holding stale handles.

const { before, after, beforeEach } = require('node:test');

const { createTestSchema, dropTestSchema, truncateAll, getPool } = require('./db');
const { seedTwoOrgs } = require('./fixtures');
const { startTestServer, stopTestServer } = require('./app');

function useTestDatabase({ withServer = true, seed = true } = {}) {
  const ctx = { pool: null, fixtures: null, baseUrl: null };

  before(async () => {
    await createTestSchema();
    ctx.pool = getPool();

    if (withServer) {
      ctx.baseUrl = await startTestServer();
    }
  });

  beforeEach(async () => {
    await truncateAll();
    if (seed) {
      ctx.fixtures = await seedTwoOrgs(ctx.pool);
    }
  });

  after(async () => {
    if (withServer) {
      await stopTestServer();
    }
    await dropTestSchema();
  });

  return { ctx };
}

module.exports = { useTestDatabase };
