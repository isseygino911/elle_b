// Bootstraps an organization's `owner` account.
//
// Why this is a script and not a migration: a migration file lives in git, and
// a password (or a password hash) must never be committed. This script takes
// the password at runtime and argon2id-hashes it before it reaches the
// database, so no credential is ever written to a file.
//
// The owner is the top of the hierarchy -- owner > manager > admin > student.
// It sees everything inside its own organization. It is deliberately a
// SEPARATE ACCOUNT from any teacher: sharing a login between the person who
// oversees and the person who teaches makes "the owner reviewed this"
// unauditable, and the schema holds exactly one role per user.
//
// Idempotent: refuses rather than duplicating if the org already has an owner
// (uq_users_owner_org_id enforces one-per-org at the DB level regardless) or
// if the email is already taken.
//
// Usage: node scripts/seed-owner.js <email> <password> [name] [orgId]
// Or:    npm run seed:owner -- <email> <password> [name] [orgId]
//
// Example (org 1 is the default organization created by migration 0016):
//   node scripts/seed-owner.js ownerelle@gmail.com '<password>' 'Elle Owner' 1
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const argon2 = require('argon2');
const pool = require('../src/db/pool');

async function main() {
  const [, , email, password, name = 'Owner', orgIdArg = '1'] = process.argv;

  if (!email || !password) {
    console.error('Usage: node scripts/seed-owner.js <email> <password> [name] [orgId]');
    process.exitCode = 1;
    return;
  }

  const orgId = Number(orgIdArg);

  if (!Number.isInteger(orgId) || orgId < 1) {
    console.error(`Invalid orgId: ${orgIdArg}`);
    process.exitCode = 1;
    return;
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Lock the organization row so two concurrent runs can't both pass the
    // "no owner yet" check below and race to insert.
    const [orgRows] = await connection.query(
      'SELECT id, name FROM organizations WHERE id = ? FOR UPDATE',
      [orgId]
    );

    if (!orgRows[0]) {
      await connection.rollback();
      console.error(
        `Organization ${orgId} does not exist. Run \`npm run migrate\` first ` +
          '(0016_create_organizations.sql seeds org 1).'
      );
      process.exitCode = 1;
      return;
    }

    const [ownerRows] = await connection.query(
      "SELECT id, email FROM users WHERE org_id = ? AND role = 'owner'",
      [orgId]
    );

    if (ownerRows[0]) {
      await connection.rollback();
      console.error(
        `Organization ${orgId} ("${orgRows[0].name}") already has an owner: ` +
          `${ownerRows[0].email} (id=${ownerRows[0].id}). Nothing to do.`
      );
      process.exitCode = 1;
      return;
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

    // admin_id is left NULL: an owner has no owning teacher. The owner is
    // oversight-only and holds no student roster of its own -- if it ever
    // needs to teach, create a separate `admin` account for that.
    const [result] = await connection.query(
      `INSERT INTO users (org_id, role, name, email, password_hash)
       VALUES (?, 'owner', ?, ?, ?)`,
      [orgId, name, email, passwordHash]
    );

    await connection.commit();

    console.log(
      `Created owner account id=${result.insertId} email=${email} ` +
        `org=${orgId} ("${orgRows[0].name}")`
    );
  } catch (err) {
    await connection.rollback();

    if (err.code === 'ER_DUP_ENTRY') {
      console.error(`A user with email ${email} already exists.`);
      process.exitCode = 1;
      return;
    }

    throw err;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
