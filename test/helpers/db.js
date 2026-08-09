'use strict';

// Scratch-schema lifecycle for the test suite.
//
// Every schema this module creates is named elle_test_<pid> and is dropped on
// teardown. Every function that can destroy data re-verifies, against the
// value the SERVER reports for SELECT DATABASE(), that it is connected to such
// a schema -- it never trusts the env var, the pool config, or the caller.
// See test/helpers/env.js for why that distinction is the whole point.

const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const { loadTestEnv, assertDisposableSchemaName } = require('./env');

const SERVER_ROOT = path.join(__dirname, '..', '..');

let pool = null;
let schemaName = null;

// Reads the schema back from the server and asserts it is disposable. This is
// the load-bearing check: an override that silently failed to apply shows up
// here, because the answer comes from the connection actually in hand rather
// than from configuration.
async function assertTestSchema(executor) {
  const [rows] = await executor.query('SELECT DATABASE() AS db');
  return assertDisposableSchemaName(rows[0] && rows[0].db);
}

// Runs migrations/run.js against the scratch schema.
//
// The runner cannot be require()d: it reads .env at module load
// (migrations/run.js:20) and calls process.exit() when finished (:91), which
// would kill the test process. So it is spawned, with DB_* overridden in the
// child's environment.
function runMigrations(config, schema) {
  const result = spawnSync(process.execPath, [path.join(SERVER_ROOT, 'migrations', 'run.js')], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      DB_HOST: config.host,
      DB_PORT: String(config.port),
      DB_USER: config.user,
      DB_PASSWORD: config.password,
      DB_NAME: schema
    },
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(
      `Migrations failed against ${schema} (exit ${result.status}).\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }

  return result.stdout;
}

async function createTestSchema() {
  const config = loadTestEnv();
  schemaName = config.schema;

  // Bootstrap connection: no database selected, so nothing is at risk while
  // the scratch schema is created.
  const bootstrap = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    multipleStatements: true
  });

  try {
    // Names are built from process.pid, never from input, so interpolation is
    // safe here -- MySQL cannot parameterize an identifier in DDL anyway.
    assertDisposableSchemaName(schemaName);
    await bootstrap.query(`DROP DATABASE IF EXISTS \`${schemaName}\``);
    await bootstrap.query(`CREATE DATABASE \`${schemaName}\``);
  } finally {
    await bootstrap.end();
  }

  // If migrations fail, drop the schema we just created before rethrowing.
  // Otherwise a failing migration orphans elle_test_<pid> on every run --
  // before() throws, after() never runs, and the schemas accumulate silently
  // until someone notices the database list growing.
  try {
    runMigrations(config, schemaName);
  } catch (err) {
    const cleanup = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password
    });
    try {
      assertDisposableSchemaName(schemaName);
      await cleanup.query(`DROP DATABASE IF EXISTS \`${schemaName}\``);
    } finally {
      await cleanup.end();
    }
    schemaName = null;
    throw err;
  }

  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: schemaName,
    connectionLimit: 5,
    // Migrations aside, the app itself never needs this; it is enabled for
    // truncateAll's single batched statement.
    multipleStatements: true
  });

  // Prove the pool landed where intended before any test uses it.
  await assertTestSchema(pool);

  return { pool, schemaName };
}

async function dropTestSchema() {
  if (!pool) {
    return;
  }

  // Verify through the pool -- i.e. the live connection -- before dropping.
  const confirmed = await assertTestSchema(pool);
  await pool.end();
  pool = null;

  const config = loadTestEnv();
  const bootstrap = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password
  });

  try {
    assertDisposableSchemaName(confirmed);
    await bootstrap.query(`DROP DATABASE IF EXISTS \`${confirmed}\``);
  } finally {
    await bootstrap.end();
  }

  schemaName = null;
}

// Empties every table between tests, preserving schema. Re-verifies the
// connection independently on each call: this is the destructive operation, so
// it does not delegate its safety to setup having been correct.
async function truncateAll() {
  if (!pool) {
    throw new Error('truncateAll() called before createTestSchema()');
  }

  await assertTestSchema(pool);

  const [rows] = await pool.query(
    `SELECT table_name AS t
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_type = 'BASE TABLE'`
  );

  const tables = rows
    .map((row) => row.t)
    // schema_migrations is bookkeeping, not test data. Wiping it would make
    // the migration runner re-apply everything on a schema that already has
    // the objects, which fails.
    .filter((name) => name !== 'schema_migrations');

  if (tables.length === 0) {
    return;
  }

  const statements = [
    'SET FOREIGN_KEY_CHECKS = 0',
    ...tables.map((name) => `TRUNCATE TABLE \`${name}\``),
    'SET FOREIGN_KEY_CHECKS = 1'
  ].join('; ');

  await pool.query(statements);
}

function getPool() {
  if (!pool) {
    throw new Error('getPool() called before createTestSchema()');
  }
  return pool;
}

module.exports = {
  createTestSchema,
  dropTestSchema,
  truncateAll,
  assertTestSchema,
  getPool,
  getSchemaName: () => schemaName
};
