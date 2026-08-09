'use strict';

// Loads .env.test and refuses to let a test run reach anything but a local
// throwaway database.
//
// ============================================================================
// THE HAZARD THIS EXISTS TO PREVENT
// ============================================================================
// .env in this repo points at production (srv1900.hstgr.io,
// u553161013_elle_project -- live data). migrations/run.js and
// src/config/env.js both read DB_NAME from it, with no NODE_ENV branch and no
// guard of any kind. A test process that inherited that config, or that
// simply failed to override it, would create schemas on the live host -- and
// truncateAll() would then be pointed at real tables.
//
// Two rules, enforced here, before any connection is opened:
//
//   1. The host must be loopback. Not "should be" -- a non-loopback host
//      aborts the process. Production is remote, so this alone makes reaching
//      it impossible regardless of what any other file says.
//   2. The schema name must start with elle_test_. Asserted here on the
//      intended value, and again in db.js on the value the server actually
//      reports via SELECT DATABASE(). The env var is intent; the runtime
//      check is the guarantee.
//
// Rule 1 is the stronger of the two and is why it comes first: a name check
// alone would still permit elle_test_x on a production host.
// ============================================================================

const path = require('path');
const fs = require('fs');

const ENV_TEST_PATH = path.join(__dirname, '..', '..', '.env.test');

// Loopback only. A DNS name that happens to resolve to 127.0.0.1 is still
// rejected: allowing it would mean trusting resolution, which can change
// between the check and the connect.
const ALLOWED_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const TEST_SCHEMA_PREFIX = 'elle_test_';

function fail(message) {
  // Written to stderr as well as thrown: a throw during module load inside a
  // test runner can surface as a terse stack, and this specific failure needs
  // to be unmissable.
  const banner = `\n${'='.repeat(72)}\nREFUSING TO RUN TESTS\n${'='.repeat(72)}\n${message}\n${'='.repeat(72)}\n`;
  process.stderr.write(banner);
  throw new Error(message);
}

function loadTestEnv() {
  if (!fs.existsSync(ENV_TEST_PATH)) {
    fail(
      `.env.test not found at ${ENV_TEST_PATH}\n\n` +
        'The suite does not fall back to .env, because .env points at\n' +
        'production. Create .env.test (see the committed template) and retry.'
    );
  }

  // Check the AMBIENT environment before loading, then the file's own values
  // after. Both must be loopback.
  //
  // Order matters and was got wrong once: loading with override:true first
  // silently replaced an exported production DB_HOST with the file's value, so
  // the subsequent check passed trivially and the guard could never fire. The
  // override is still correct -- the file must win over a stale shell export --
  // but "the file won" is not the same as "the ambient value was safe", and
  // only one of those is worth asserting.
  const ambientHost = (process.env.DB_HOST || '').trim();
  if (ambientHost && !ALLOWED_HOSTS.has(ambientHost)) {
    fail(
      `DB_HOST is exported in this shell as "${ambientHost}", which is not a\n` +
        'loopback address.\n\n' +
        'Refusing to run even though .env.test would have overridden it: a\n' +
        'production hostname reaching a test process means something upstream\n' +
        'is misconfigured, and the next thing to read it might not override.'
    );
  }

  // The schema this process resolved on its FIRST call, captured before dotenv
  // can overwrite it.
  //
  // loadTestEnv() is called repeatedly -- by the preload, and again by db.js on
  // create and on drop -- and `override: true` below re-reads .env.test every
  // time. .env.test carries the BASE name (elle_test, no pid), so every call
  // after the first was resetting process.env.DB_NAME from the pid-suffixed
  // schema back to the bare base name.
  //
  // Nothing noticed while the app's pool stayed in require.cache, because it
  // had already been built from the correct value. But stopTestServer() evicts
  // src/db/pool from the cache by design, so the next require rebuilt the pool
  // from the clobbered DB_NAME and connected to the literal database
  // "elle_test" -- which does not exist.
  //
  // The failure mode is what made this expensive to find: mysql2 raises
  // ER_BAD_DB_ERROR on the connection rather than on a query, so inside the
  // test runner it surfaced as a request that never returned -- a hang with no
  // failing assertion -- instead of an error naming the missing database.
  const preResolved = (process.env.DB_NAME || '').trim();

  // override: true because a developer shell may already export DB_NAME or
  // DB_USER from the production .env -- those must lose to this file, not win.
  require('dotenv').config({ path: ENV_TEST_PATH, override: true });

  const host = (process.env.DB_HOST || '').trim();
  if (!ALLOWED_HOSTS.has(host)) {
    fail(
      `DB_HOST is "${host}", which is not a loopback address.\n\n` +
        `Tests may only run against a local database. Allowed: ${[...ALLOWED_HOSTS].join(', ')}.\n` +
        'If this says srv1900.hstgr.io, .env.test was not loaded and the run\n' +
        'was about to touch PRODUCTION.'
    );
  }

  const baseName = (process.env.DB_NAME || '').trim();
  if (!baseName.startsWith('elle_test')) {
    fail(
      `DB_NAME is "${baseName}", which does not start with "elle_test".\n\n` +
        'The harness only ever creates and drops schemas it can prove are\n' +
        'disposable.'
    );
  }

  // Per-process schema: parallel runs cannot collide, and teardown drops only
  // the name this process built.
  //
  // If this process already resolved a schema, reuse it verbatim. Recomputing
  // from process.pid would usually agree, but "usually" is not good enough
  // here: the app's pool was built from the first call's value, and fixtures
  // writing to a different schema than the routes read from is a failure mode
  // that looks like missing data rather than misconfiguration.
  //
  // Read from preResolved -- the value captured BEFORE dotenv ran -- not from
  // process.env, which dotenv has just reset to the base name.
  const schema = preResolved.startsWith(TEST_SCHEMA_PREFIX) && /\d+$/.test(preResolved)
    ? preResolved
    : `${TEST_SCHEMA_PREFIX}${process.pid}`;

  // Write the resolved schema back, so a later require of src/db/pool.js -- or
  // anything else reading DB_NAME -- sees the scratch schema and not the base
  // name dotenv just restored. Without this the value survives only until the
  // next loadTestEnv() call.
  process.env.DB_NAME = schema;

  return {
    host,
    port: Number(process.env.DB_PORT) || 3307,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    schema
  };
}

// Shared by db.js for its post-connect SELECT DATABASE() assertion.
function assertDisposableSchemaName(name) {
  if (typeof name !== 'string' || !name.startsWith(TEST_SCHEMA_PREFIX)) {
    fail(
      `Connected to schema "${name}", which is not a disposable test schema.\n\n` +
        `Every destructive helper requires a name starting with "${TEST_SCHEMA_PREFIX}".\n` +
        'Refusing to touch it.'
    );
  }
  return name;
}

module.exports = {
  loadTestEnv,
  assertDisposableSchemaName,
  TEST_SCHEMA_PREFIX,
  ALLOWED_HOSTS
};
