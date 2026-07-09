// Bootstraps the first 'elle' (teacher/admin) account, since the app's own
// registration flow only ever creates 'student' accounts via an invitation.
// Usage: node server/scripts/seed-elle.js <email> <password> [name]
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const argon2 = require('argon2');
const pool = require('../src/db/pool');

async function main() {
  const [, , email, password, name = 'Elle'] = process.argv;

  if (!email || !password) {
    console.error('Usage: node server/scripts/seed-elle.js <email> <password> [name]');
    process.exitCode = 1;
    return;
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  try {
    const [result] = await pool.query(
      `INSERT INTO users (role, name, email, password_hash) VALUES ('elle', ?, ?, ?)`,
      [name, email, passwordHash]
    );
    console.log(`Created elle account id=${result.insertId} email=${email}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      console.error(`A user with email ${email} already exists.`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
