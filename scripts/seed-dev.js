'use strict';

// Seeds the LOCAL dev database with a usable teaching scenario: an org, a
// teacher, three students, a course with everyone enrolled, and three
// assignments in the states you actually want to look at (published with all
// three parts, published text-only, and a draft).
//
// ---------------------------------------------------------------------------
// WHY THIS IS SAFE TO RUN, AND WHY IT REFUSES TO RUN ANYWHERE ELSE
// ---------------------------------------------------------------------------
// .env points at PRODUCTION (srv1900.hstgr.io / u553161013_elle_project). A
// seeder that inherited that config would create fake teachers and fake
// homework on the live system, and notify real students about assignments
// that do not exist.
//
// So this file never reads .env. It requires DEV_ENV_FILE to be passed
// explicitly, and then independently asserts -- against the connection it is
// actually holding, not against the env vars it was given -- that the host is
// loopback and the schema is not the production one. The env var is the
// intent; the runtime check is the guarantee. That is the same two-layer
// pattern test/helpers/env.js uses, for the same reason.
//
// ---------------------------------------------------------------------------
// IDEMPOTENT BY DESIGN
// ---------------------------------------------------------------------------
// It UPSERTS. Running it twice does not duplicate anything and does not wipe
// anything. This is deliberate: a seeder that clears tables first is fine for
// a scripted run that owns the database, and actively hostile to a human who
// has spent ten minutes clicking around and wants one more student added.
//
// Usage (from elle_b/):
//   DEV_ENV_FILE=/path/to/.env.dev node scripts/seed-dev.js

const path = require('path');
const argon2 = require('argon2');
const mysql = require('mysql2/promise');

const ENV_FILE = process.env.DEV_ENV_FILE;
if (!ENV_FILE) {
  console.error(
    'Refusing to run: DEV_ENV_FILE is not set.\n\n' +
      'This seeder will not fall back to .env, because .env points at production.\n' +
      'Pass an env file pinned at the local container, e.g.\n' +
      '  DEV_ENV_FILE=./.env.dev node scripts/seed-dev.js'
  );
  process.exit(1);
}
require('dotenv').config({ path: path.resolve(ENV_FILE) });

const PASSWORD = process.env.SEED_PASSWORD || 'DevPass123!';

// Layer 1: the declared target must be loopback.
const HOST = process.env.DB_HOST;
const SCHEMA = process.env.DB_NAME;
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  console.error(`Refusing to run: DB_HOST is "${HOST}", which is not loopback.`);
  process.exit(1);
}
if (/u\d{9}_|elle_project/.test(String(SCHEMA))) {
  console.error(`Refusing to run: DB_NAME "${SCHEMA}" looks like the production schema.`);
  process.exit(1);
}

const ORG_NAME = 'Elle Dev Music School';

async function main() {
  const db = await mysql.createConnection({
    host: HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: SCHEMA,
  });

  // Layer 2: ask the connection itself where it landed. An env var can lie
  // about which server answered; SELECT cannot.
  const [[live]] = await db.query('SELECT DATABASE() db');
  if (/u\d{9}_|elle_project/.test(String(live.db))) {
    await db.end();
    throw new Error(`Connected schema is "${live.db}" -- aborting before any write.`);
  }
  // The port printed is the one WE dialled, not @@port: inside docker the
  // server reports its container-internal 3306, which reads as "you are on the
  // default port" and is exactly the confusion .env.local.db chose 3307 to
  // avoid.
  console.log(`Seeding ${live.db} on ${HOST}:${process.env.DB_PORT}\n`);

  const hash = await argon2.hash(PASSWORD);

  // --- org -----------------------------------------------------------------
  let [[org]] = await db.query('SELECT id FROM organizations WHERE name = ?', [ORG_NAME]);
  if (!org) {
    const [r] = await db.query('INSERT INTO organizations (name) VALUES (?)', [ORG_NAME]);
    org = { id: r.insertId };
    console.log(`  + organization "${ORG_NAME}" (id ${org.id})`);
  } else {
    console.log(`  = organization "${ORG_NAME}" (id ${org.id})`);
  }

  // --- users ---------------------------------------------------------------
  // Email is the natural key here: it is what a person types into the login
  // form, so it is what "the same user" means to the human running this.
  async function upsertUser({ role, name, email, adminId = null }) {
    const [[found]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (found) {
      // Reset the password on every run so a forgotten local password is
      // never a reason to wipe the database.
      await db.query(
        'UPDATE users SET org_id=?, role=?, admin_id=?, name=?, password_hash=? WHERE id=?',
        [org.id, role, adminId, name, hash, found.id]
      );
      console.log(`  = ${role.padEnd(7)} ${email} (id ${found.id})`);
      return found.id;
    }
    const [r] = await db.query(
      'INSERT INTO users (org_id, role, admin_id, name, email, password_hash) VALUES (?,?,?,?,?,?)',
      [org.id, role, adminId, name, email, hash]
    );
    console.log(`  + ${role.padEnd(7)} ${email} (id ${r.insertId})`);
    return r.insertId;
  }

  console.log('\nUsers:');
  await upsertUser({ role: 'owner', name: 'Olivia Owner', email: 'owner@dev.test' });
  const teacherId = await upsertUser({ role: 'admin', name: 'Tina Teacher', email: 'teacher@dev.test' });
  await upsertUser({ role: 'manager', name: 'Mo Manager', email: 'manager@dev.test' });
  const students = [];
  for (const [name, email] of [
    ['Alice Anderson', 'alice@dev.test'],
    ['Ben Brooks', 'ben@dev.test'],
    ['Chloe Chen', 'chloe@dev.test'],
  ]) {
    students.push(await upsertUser({ role: 'student', name, email, adminId: teacherId }));
  }

  // --- course --------------------------------------------------------------
  console.log('\nCourse:');
  const COURSE_TITLE = 'Piano Fundamentals — Term 1';
  let [[course]] = await db.query('SELECT id FROM courses WHERE org_id = ? AND title = ?', [
    org.id,
    COURSE_TITLE,
  ]);
  if (!course) {
    const [r] = await db.query(
      'INSERT INTO courses (org_id, admin_id, title, description, status) VALUES (?,?,?,?,?)',
      [
        org.id,
        teacherId,
        COURSE_TITLE,
        'Scales, arpeggios and one study piece. Weekly homework with a recorded run-through.',
        'active',
      ]
    );
    course = { id: r.insertId };
    console.log(`  + "${COURSE_TITLE}" (id ${course.id})`);
  } else {
    console.log(`  = "${COURSE_TITLE}" (id ${course.id})`);
  }

  for (const studentId of students) {
    // The unique key makes this safe to repeat -- the same guarantee the route
    // relies on to answer 409 rather than racing.
    await db.query(
      'INSERT IGNORE INTO course_enrollments (org_id, course_id, student_id) VALUES (?,?,?)',
      [org.id, course.id, studentId]
    );
  }
  console.log(`  = ${students.length} students enrolled`);

  // --- assignments ---------------------------------------------------------
  // Dates are computed relative to today so the dashboard's 14-day lookahead
  // window (assignments.helpers.js:51) always has something in it, however
  // long after this file was written it gets run.
  const plusDays = (n) =>
    new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  console.log('\nAssignments:');
  const ASSIGNMENTS = [
    {
      title: 'Week 3 — C major scale, hands together',
      body:
        'Play the C major scale two octaves, hands together, slowly and evenly.\n\n' +
        'Record yourself once through. Then write two or three sentences on what felt hardest.\n\n' +
        'Attach your practice log if you kept one.',
      reference_url: 'https://imslp.org/wiki/Category:Scales',
      due_date: plusDays(5),
      allowed_attempts: 3,
      accepts_text: 1,
      accepts_files: 1,
      accepts_recording: 1,
      max_recording_sec: 300,
      status: 'published',
    },
    {
      title: 'Listening reflection — Chopin Nocturne Op. 9 No. 2',
      body:
        'Listen to the nocturne twice. Write a short paragraph on what the left hand is doing ' +
        'underneath the melody, and where you hear the piece breathe.',
      reference_url: 'https://www.youtube.com/results?search_query=chopin+nocturne+op+9+no+2',
      due_date: plusDays(12),
      allowed_attempts: null,
      accepts_text: 1,
      accepts_files: 0,
      accepts_recording: 0,
      max_recording_sec: 300,
      status: 'published',
    },
    {
      title: 'Recital piece — first read-through (DRAFT)',
      body:
        'Not published yet. Exists so the draft state is visible to a teacher and invisible ' +
        'to a student.',
      reference_url: null,
      due_date: plusDays(30),
      allowed_attempts: 2,
      accepts_text: 1,
      accepts_files: 1,
      accepts_recording: 1,
      max_recording_sec: 600,
      status: 'draft',
    },
  ];

  for (const a of ASSIGNMENTS) {
    const [[found]] = await db.query(
      'SELECT id FROM assignments WHERE course_id = ? AND title = ?',
      [course.id, a.title]
    );
    if (found) {
      console.log(`  = ${a.status.padEnd(9)} "${a.title}" (id ${found.id})`);
      continue;
    }
    const [r] = await db.query(
      `INSERT INTO assignments
         (org_id, course_id, title, body, reference_url, due_date, allowed_attempts,
          accepts_text, accepts_files, accepts_recording, max_recording_sec, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        org.id, course.id, a.title, a.body, a.reference_url, a.due_date, a.allowed_attempts,
        a.accepts_text, a.accepts_files, a.accepts_recording, a.max_recording_sec, a.status,
        teacherId,
      ]
    );
    console.log(`  + ${a.status.padEnd(9)} "${a.title}" (id ${r.insertId})`);

    // Published assignments notify the enrolled students, exactly as the
    // publish route does. Seeding the row without the notification would
    // produce a state the application itself can never reach.
    if (a.status === 'published') {
      for (const studentId of students) {
        await db.query(
          `INSERT INTO notifications (org_id, user_id, actor_id, type, ref_id, title, body)
           VALUES (?,?,?,?,?,?,?)`,
          [
            org.id, studentId, teacherId, 'assignment_published', r.insertId,
            `New homework: ${a.title}`, a.due_date ? `Due ${a.due_date}` : null,
          ]
        );
      }
    }
  }

  await db.end();

  console.log('\n' + '='.repeat(64));
  console.log('LOGIN CREDENTIALS (local only)');
  console.log('='.repeat(64));
  console.log(`  password for every account below:  ${PASSWORD}\n`);
  console.log('  teacher@dev.test   Tina Teacher    — owns the course, reviews work');
  console.log('  alice@dev.test     Alice Anderson  — enrolled student');
  console.log('  ben@dev.test       Ben Brooks      — enrolled student');
  console.log('  chloe@dev.test     Chloe Chen      — enrolled student');
  console.log('  owner@dev.test     Olivia Owner    — sees the whole org');
  console.log('  manager@dev.test   Mo Manager      — must be REFUSED everywhere');
  console.log('='.repeat(64));
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message);
  process.exit(1);
});
