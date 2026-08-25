'use strict';

/**
 * Plain migration runner for server/migrations/*.sql
 *
 * Convention:
 *   - Files are named NNNN_description.sql (4-digit zero-padded sequence +
 *     snake_case description), applied in filename (sorted) order.
 *   - Applied migrations are recorded in the schema_migrations table, keyed
 *     by filename minus the .sql extension.
 *   - No transaction/rollback machinery — each file is run as-is, once.
 *
 * Usage (from server/): npm run migrate
 * (wired by backend-engineer to `node migrations/run.js` in server/package.json)
 *
 * Target DB: .env by default, which is PRODUCTION. Override with ENV_FILE to
 * point somewhere else, matching the `npm run local` script's convention:
 *   ENV_FILE=.env.dev npm run migrate
 * Always apply to dev first -- a migration that fails should fail there.
 */

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', process.env.ENV_FILE || '.env') });

const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = __dirname;

async function getConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });
}

function getMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

async function ensureBookkeepingTable(connection) {
  const initFile = path.join(MIGRATIONS_DIR, '0000_init.sql');
  const sql = fs.readFileSync(initFile, 'utf8');
  await connection.query(sql);
}

async function getAppliedIds(connection) {
  const [rows] = await connection.query(
    'SELECT id FROM schema_migrations'
  );
  return new Set(rows.map((row) => row.id));
}

async function run() {
  const connection = await getConnection();

  try {
    await ensureBookkeepingTable(connection);

    const applied = await getAppliedIds(connection);
    const files = getMigrationFiles();

    for (const file of files) {
      const id = file.replace(/\.sql$/, '');

      if (applied.has(id)) {
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      console.log(`Applying migration: ${file}`);
      await connection.query(sql);
      await connection.query(
        'INSERT INTO schema_migrations (id) VALUES (?)',
        [id]
      );
    }

    console.log('Migrations complete.');
  } finally {
    await connection.end();
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  }
);
