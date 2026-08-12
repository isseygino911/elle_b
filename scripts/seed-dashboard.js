'use strict';

// Fills the LOCAL dev database with enough activity to exercise every zone of
// the redesigned dashboard: videos waiting for review at a spread of ages,
// unread messages, bookings inside and outside the 24-hour window, pending and
// overdue tasks, and notifications.
//
// ---------------------------------------------------------------------------
// WHY THIS REFUSES TO RUN ANYWHERE BUT LOCALHOST
// ---------------------------------------------------------------------------
// .env points at PRODUCTION (srv1900.hstgr.io / u553161013_elle_project).
// Seeding fake practice videos against real student rows would notify real
// people about submissions that do not exist. So this file never reads .env:
// it requires DEV_ENV_FILE explicitly, then independently asserts -- against
// the connection it is actually holding, not the env vars it was handed --
// that the host is loopback and the schema is not production. Same two-layer
// pattern as seed-dev.js, for the same reason.
//
// ---------------------------------------------------------------------------
// WHY THE DATES ARE SPREAD THE WAY THEY ARE
// ---------------------------------------------------------------------------
// A seeder that inserts everything at NOW() produces a dashboard where every
// panel is technically populated and nothing is distinguishable. The redesign
// reads AGE, not just count:
//
//   - ReviewBacklogAge buckets pending videos into today / 2-3d / 4-7d / 1wk+
//     and colours only the oldest bucket. Videos must land in all four, and at
//     least one must be >= 7 days old for the "oldest has been waiting" line.
//   - ProgressDistribution bands students 0-25/25-50/50-75/75-100, so
//     submissions are uneven across students on purpose.
//   - upcoming_bookings is next 24 HOURS; anything later is deliberately
//     outside it, to prove the KPI label is honest rather than just nonzero.
//   - TasksList computes overdue client-side from an unfiltered due_date, so
//     one task is dated in the past. Homework due is server-filtered to
//     due_date >= CURDATE() and can never be overdue -- that asymmetry is the
//     point, so do not "fix" it by backdating an assignment.
//
// Usage (from elle_b/):
//   DEV_ENV_FILE=./.env.dev node scripts/seed-dashboard.js

const path = require('path');
const crypto = require('crypto');
const argon2 = require('argon2');
const mysql = require('mysql2/promise');

const ENV_FILE = process.env.DEV_ENV_FILE;
if (!ENV_FILE) {
  console.error(
    'Refusing to run: DEV_ENV_FILE is not set.\n\n' +
      'This seeder will not fall back to .env, because .env points at production.\n' +
      'Pass an env file pinned at the local container, e.g.\n' +
      '  DEV_ENV_FILE=./.env.dev node scripts/seed-dashboard.js'
  );
  process.exit(1);
}
require('dotenv').config({ path: path.resolve(ENV_FILE) });

const PASSWORD = process.env.SEED_PASSWORD || 'DevPass123!';
const HOST = process.env.DB_HOST;
const SCHEMA = process.env.DB_NAME;

// Layer 1: the declared target must be loopback.
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  console.error(`Refusing to run: DB_HOST is "${HOST}", which is not loopback.`);
  process.exit(1);
}
if (/u\d{9}_|elle_project/.test(String(SCHEMA))) {
  console.error(`Refusing to run: DB_NAME "${SCHEMA}" looks like the production schema.`);
  process.exit(1);
}

const ORG_NAME = 'Elle Dev Music School';

// The account asked for. Kept as a constant because it is the one thing a
// human running this actually needs to remember.
//
// Overridable so this seeder can dress ANY teacher's dashboard, not just the
// one it was written for -- the .env.dev accounts from seed-dev.js are the
// other set a human logs in as, and they were reaching an empty dashboard
// because every row below hung off admin@admin.com instead. The data shapes
// (ages, buckets, windows) are what makes this file worth reusing; only whose
// they are needed to vary.
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@admin.com';
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Admin Teacher';

// Same override for the roster. Passed as "Name:email" pairs so an existing
// student keeps its name on upsert (email is the natural key) rather than
// being renamed by a positional default.
const STUDENT_ROSTER = process.env.SEED_STUDENTS
  ? process.env.SEED_STUDENTS.split(',').map((pair) => {
      const [name, email] = pair.split(':');
      return [name.trim(), email.trim()];
    })
  : [
      ['Ava Reynolds', 'ava@admin.test'],
      ['Noah Fletcher', 'noah@admin.test'],
      ['Mia Sandoval', 'mia@admin.test'],
      ['Leo Nakamura', 'leo@admin.test'],
      ['Zoe Halloway', 'zoe@admin.test'],
      ['Ethan Brandt', 'ethan@admin.test'],
    ];

// The data plans below were written against a six-student roster and index it
// positionally. A shorter roster (SEED_STUDENTS) would run off the end, so the
// index wraps -- every planned row still gets created, just distributed across
// however many students there are. Wrapping rather than skipping matters
// because the plans are balanced by AGE and bucket, not by student: dropping
// rows would empty the very dashboard buckets this seeder exists to fill.
const pick = (list, i) => list[i % list.length];

const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const hoursFromNow = (n) => new Date(Date.now() + n * 3600000);
const ymd = (d) => d.toISOString().slice(0, 10);

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
  // Email is the natural key: it is what a person types into the login form,
  // so it is what "the same user" means to the human running this.
  async function upsertUser({ role, name, email, adminId = null }) {
    const [[found]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (found) {
      await db.query(
        'UPDATE users SET org_id=?, role=?, admin_id=?, name=?, password_hash=? WHERE id=?',
        [org.id, role, adminId, name, hash, found.id]
      );
      console.log(`  = ${role.padEnd(8)} ${email} (id ${found.id})`);
      return found.id;
    }
    const [r] = await db.query(
      'INSERT INTO users (org_id, role, admin_id, name, email, password_hash) VALUES (?,?,?,?,?,?)',
      [org.id, role, adminId, name, email, hash]
    );
    console.log(`  + ${role.padEnd(8)} ${email} (id ${r.insertId})`);
    return r.insertId;
  }

  console.log('Users:');
  // 'admin' is the teacher role in this schema; it is the role whose dashboard
  // has the most surface, which is what makes it the useful one to log in as.
  const adminId = await upsertUser({ role: 'admin', name: ADMIN_NAME, email: ADMIN_EMAIL });

  // Students belong to this teacher via admin_id -- that column is what every
  // scoped dashboard query filters on, so students attached to a different
  // teacher would leave the dashboard empty no matter how much data exists.
  const students = [];
  for (const [name, email] of STUDENT_ROSTER) {
    students.push({ id: await upsertUser({ role: 'student', name, email, adminId }), name });
  }

  // --- videos awaiting review ---------------------------------------------
  // Ages chosen to land one in each ReviewBacklogAge bucket, with the 11-day
  // video triggering the "oldest has been waiting N days" warning.
  console.log('\nPractice videos (pending review):');
  const videoPlan = [
    { student: 0, title: 'Scales in G major - week 6', age: 0 },
    { student: 1, title: 'Etude no. 3, first attempt', age: 0 },
    { student: 2, title: 'Sight reading drill', age: 2 },
    { student: 3, title: 'Arpeggio practice, slow tempo', age: 3 },
    { student: 4, title: 'Chord transitions - problem bars', age: 5 },
    { student: 0, title: 'Metronome practice 80bpm', age: 6 },
    { student: 5, title: 'Recital piece, full run-through', age: 11 },
  ];
  for (const v of videoPlan) {
    const student = pick(students, v.student);
    // s3_key is UNIQUE, so it doubles as the idempotency key: a deterministic
    // key means re-running updates in place instead of duplicating the row.
    const s3Key = `dev-seed/${student.id}/${crypto.createHash('sha1').update(v.title).digest('hex').slice(0, 12)}.mp4`;
    const [[found]] = await db.query('SELECT id FROM videos WHERE s3_key = ?', [s3Key]);
    if (found) {
      await db.query('UPDATE videos SET status=?, created_at=? WHERE id=?', [
        'pending_review',
        daysAgo(v.age),
        found.id,
      ]);
      console.log(`  = ${v.title} (${v.age}d)`);
    } else {
      await db.query(
        `INSERT INTO videos (org_id, admin_id, type, student_id, title, s3_key, duration_sec, status, uploaded_by, created_at)
         VALUES (?,?,'practice',?,?,?,?, 'pending_review', ?, ?)`,
        [org.id, adminId, student.id, v.title, s3Key, 120 + v.age * 7, student.id, daysAgo(v.age)]
      );
      console.log(`  + ${v.title} (${v.age}d)`);
    }
  }

  // --- unread messages -----------------------------------------------------
  // sender_id must be the STUDENT: the dashboard counts unread where
  // sender_id != the viewer, so a teacher-sent message would not count.
  console.log('\nUnread messages:');
  const messagePlan = [
    { student: 0, body: 'Should I keep using the metronome for the slow section?', age: 0 },
    { student: 1, body: 'I recorded the etude again, hope the timing is better.', age: 1 },
    { student: 1, body: 'Also, can we move Thursday a bit later?', age: 1 },
    { student: 3, body: 'My left hand keeps tensing up on the arpeggios.', age: 2 },
    { student: 5, body: 'Ready for the recital piece feedback whenever you have time.', age: 4 },
  ];
  for (const m of messagePlan) {
    const student = pick(students, m.student);
    const [[found]] = await db.query(
      'SELECT id FROM messages WHERE student_id=? AND body=?',
      [student.id, m.body]
    );
    if (found) {
      await db.query('UPDATE messages SET read_at=NULL, created_at=? WHERE id=?', [daysAgo(m.age), found.id]);
      console.log(`  = ${student.name}: ${m.body.slice(0, 40)}...`);
    } else {
      await db.query(
        `INSERT INTO messages (org_id, admin_id, student_id, sender_id, body, read_at, created_at)
         VALUES (?,?,?,?,?, NULL, ?)`,
        [org.id, adminId, student.id, student.id, m.body, daysAgo(m.age)]
      );
      console.log(`  + ${student.name}: ${m.body.slice(0, 40)}...`);
    }
  }

  // --- bookings ------------------------------------------------------------
  // Two inside the next 24h (the KPI window) and two beyond it, so the strip
  // number and the "upcoming" list below it deliberately disagree -- which is
  // what proves the label "Sessions next 24h" is telling the truth.
  console.log('\nBookings:');
  const bookingPlan = [
    { student: 0, inHours: 3 },
    { student: 2, inHours: 20 },
    { student: 4, inHours: 40 },
    { student: 1, inHours: 70 },
  ];
  for (const b of bookingPlan) {
    const student = pick(students, b.student);
    const when = hoursFromNow(b.inHours);
    const [[found]] = await db.query(
      "SELECT id FROM bookings WHERE student_id=? AND status='booked' AND ABS(TIMESTAMPDIFF(MINUTE, scheduled_at, ?)) < 90",
      [student.id, when]
    );
    if (found) {
      console.log(`  = ${student.name} in ${b.inHours}h`);
      continue;
    }
    await db.query(
      `INSERT INTO bookings (org_id, admin_id, student_id, scheduled_at, duration_min, status, jitsi_room_id)
       VALUES (?,?,?,?,30,'booked',?)`,
      [org.id, adminId, student.id, when, crypto.randomUUID()]
    );
    console.log(`  + ${student.name} in ${b.inHours}h`);
  }

  // A few completed sessions in the past, so the manager rollup has non-zero
  // completed_sessions to report.
  for (const [i, student] of students.slice(0, 4).entries()) {
    const when = daysAgo(i + 2);
    const [[found]] = await db.query(
      "SELECT id FROM bookings WHERE student_id=? AND status='completed' AND ABS(TIMESTAMPDIFF(MINUTE, scheduled_at, ?)) < 90",
      [student.id, when]
    );
    if (!found) {
      await db.query(
        `INSERT INTO bookings (org_id, admin_id, student_id, scheduled_at, duration_min, status, jitsi_room_id)
         VALUES (?,?,?,?,30,'completed',?)`,
        [org.id, adminId, student.id, when, crypto.randomUUID()]
      );
    }
  }

  // --- tasks ---------------------------------------------------------------
  // One dated in the past on purpose: serializeTask returns due_date
  // unfiltered, so TasksList is the ONE place on the dashboard that can
  // honestly show an overdue state.
  console.log('\nTasks:');
  const taskPlan = [
    { title: 'Prepare recital programme', dueInDays: -2 },
    { title: 'Send practice plan to Ava', dueInDays: 0 },
    { title: 'Review Noah’s etude recording', dueInDays: 1 },
    { title: 'Order new sheet music', dueInDays: 4 },
    { title: 'Update studio availability for next month', dueInDays: 9 },
  ];
  for (const t of taskPlan) {
    const due = ymd(new Date(Date.now() + t.dueInDays * 86400000));
    const [[found]] = await db.query('SELECT id FROM tasks WHERE org_id=? AND title=?', [org.id, t.title]);
    if (found) {
      await db.query('UPDATE tasks SET status=?, due_date=?, assigned_to=? WHERE id=?', [
        'pending',
        due,
        adminId,
        found.id,
      ]);
      console.log(`  = ${t.title} (due ${due})`);
    } else {
      await db.query(
        `INSERT INTO tasks (org_id, title, assigned_to, status, due_date, created_by)
         VALUES (?,?,?,'pending',?,?)`,
        [org.id, t.title, adminId, due, adminId]
      );
      console.log(`  + ${t.title} (due ${due})`);
    }
  }

  // Some completed tasks so the manager's pending/done ratio panel has both
  // halves to draw.
  for (const title of ['Confirm term dates', 'Restock practice room supplies']) {
    const [[found]] = await db.query('SELECT id FROM tasks WHERE org_id=? AND title=?', [org.id, title]);
    if (!found) {
      await db.query(
        `INSERT INTO tasks (org_id, title, assigned_to, status, due_date, created_by)
         VALUES (?,?,?,'done',?,?)`,
        [org.id, title, adminId, ymd(daysAgo(3)), adminId]
      );
    }
  }

  // --- course + homework due ----------------------------------------------
  // assignments has no admin_id: ownership is the parent course's, and
  // fetchAssignmentsDue scopes on c.admin_id. A course owned by a different
  // teacher therefore contributes nothing to THIS dashboard, which is why the
  // course is created here rather than reusing the one already in the db.
  //
  // Every due_date is >= today on purpose. The server filters
  // due_date >= CURDATE(), so a backdated assignment would simply vanish
  // rather than render as overdue -- homework has no overdue state to show.
  console.log('\nCourse + homework:');
  let [[course]] = await db.query('SELECT id FROM courses WHERE org_id=? AND admin_id=? AND title=?', [
    org.id,
    adminId,
    'Piano Foundations',
  ]);
  if (!course) {
    const [r] = await db.query(
      "INSERT INTO courses (org_id, admin_id, title, description, status) VALUES (?,?,?,?,'active')",
      [org.id, adminId, 'Piano Foundations', 'Term 3 — technique, sight reading and repertoire.']
    );
    course = { id: r.insertId };
    console.log(`  + course "Piano Foundations" (id ${course.id})`);
  } else {
    console.log(`  = course "Piano Foundations" (id ${course.id})`);
  }

  for (const student of students) {
    const [[enrolled]] = await db.query(
      'SELECT id FROM course_enrollments WHERE course_id=? AND student_id=?',
      [course.id, student.id]
    );
    if (!enrolled) {
      await db.query('INSERT INTO course_enrollments (org_id, course_id, student_id) VALUES (?,?,?)', [
        org.id,
        course.id,
        student.id,
      ]);
    }
  }

  for (const a of [
    { title: 'Hanon exercises 1-4', dueInDays: 1 },
    { title: 'Listening journal: Debussy', dueInDays: 3 },
    { title: 'Record scales at 60bpm', dueInDays: 8 },
  ]) {
    const due = ymd(new Date(Date.now() + a.dueInDays * 86400000));
    const [[found]] = await db.query('SELECT id FROM assignments WHERE course_id=? AND title=?', [
      course.id,
      a.title,
    ]);
    if (found) {
      await db.query("UPDATE assignments SET due_date=?, status='published' WHERE id=?", [due, found.id]);
      console.log(`  = ${a.title} (due ${due})`);
    } else {
      await db.query(
        `INSERT INTO assignments (org_id, course_id, title, body, due_date, status, created_by)
         VALUES (?,?,?,?,?, 'published', ?)`,
        [org.id, course.id, a.title, 'See the course page for details.', due, adminId]
      );
      console.log(`  + ${a.title} (due ${due})`);
    }
  }

  // --- survey progress -----------------------------------------------------
  // ProgressDistribution bands students by completion_ratio, which comes from
  // SURVEY responses (completed_questions / total_questions) -- not from
  // courses or submissions. Without this block every student sits at 0 and the
  // panel draws a single bar in the 0-25% band, which looks like a broken
  // chart rather than a studio where nobody has started.
  //
  // 12 questions, and the answer counts below are chosen to put at least one
  // student in each of the four bands.
  console.log('\nSurvey progress:');
  const QUESTION_COUNT = 12;
  let [[survey]] = await db.query('SELECT id FROM surveys WHERE org_id=? AND title=?', [
    org.id,
    'Term 3 Skills Check',
  ]);
  if (!survey) {
    const [r] = await db.query(
      'INSERT INTO surveys (org_id, title, s3_key, original_filename) VALUES (?,?,?,?)',
      [org.id, 'Term 3 Skills Check', `dev-seed/surveys/term3-${org.id}.csv`, 'term3-skills-check.csv']
    );
    survey = { id: r.insertId };
    console.log(`  + survey "Term 3 Skills Check" (id ${survey.id})`);
  } else {
    console.log(`  = survey "Term 3 Skills Check" (id ${survey.id})`);
  }

  const questionIds = [];
  for (let i = 0; i < QUESTION_COUNT; i++) {
    const text = `Skills check question ${i + 1}`;
    let [[q]] = await db.query('SELECT id FROM survey_questions WHERE survey_id=? AND order_index=?', [
      survey.id,
      i,
    ]);
    if (!q) {
      const [r] = await db.query(
        'INSERT INTO survey_questions (org_id, survey_id, order_index, question_text, points) VALUES (?,?,?,?,5)',
        [org.id, survey.id, i, text]
      );
      q = { id: r.insertId };
    }
    // Each question needs at least one answer row for a response to point at.
    let [[ans]] = await db.query('SELECT id FROM survey_answers WHERE question_id=? AND order_index=0', [q.id]);
    if (!ans) {
      const [r] = await db.query(
        'INSERT INTO survey_answers (org_id, question_id, order_index, answer_text, points) VALUES (?,?,0,?,5)',
        [org.id, q.id, 'Confident']
      );
      ans = { id: r.insertId };
    }
    questionIds.push({ questionId: q.id, answerId: ans.id });
  }

  // Answered counts -> ratios: 11/12=92%, 9/12=75%, 7/12=58%, 5/12=42%,
  // 2/12=17%, 0/12=0%. That fills 75-100, 50-75, 25-50 and 0-25.
  const answeredPlan = [11, 9, 7, 5, 2, 0];
  for (const [i, student] of students.entries()) {
    const answered = answeredPlan[i];
    for (let q = 0; q < answered; q++) {
      const { questionId, answerId } = questionIds[q];
      const [[found]] = await db.query(
        'SELECT id FROM survey_responses WHERE survey_id=? AND question_id=? AND student_id=?',
        [survey.id, questionId, student.id]
      );
      if (!found) {
        await db.query(
          `INSERT INTO survey_responses (survey_id, question_id, student_id, answer_id, points_earned, submitted_at)
           VALUES (?,?,?,?,5,?)`,
          [survey.id, questionId, student.id, answerId, daysAgo(i + 1)]
        );
      }
    }
    console.log(`  ${student.name.padEnd(16)} ${answered}/${QUESTION_COUNT}`);
  }

  // --- notifications -------------------------------------------------------
  // actor_id is always set. A notification whose actor is missing renders as
  // "undefined submitted ..." in the UI, which is exactly the bug visible in
  // production right now -- so this seeder must not reproduce it.
  console.log('\nNotifications:');
  const notifPlan = [
    { student: 0, type: 'video_uploaded', title: 'New practice video', body: 'Scales in G major - week 6', age: 0 },
    { student: 1, type: 'message', title: 'New message', body: 'I recorded the etude again', age: 1 },
    { student: 3, type: 'message', title: 'New message', body: 'My left hand keeps tensing up', age: 2 },
    { student: 5, type: 'video_uploaded', title: 'New practice video', body: 'Recital piece, full run-through', age: 11 },
  ];
  for (const n of notifPlan) {
    const student = pick(students, n.student);
    const [[found]] = await db.query(
      'SELECT id FROM notifications WHERE user_id=? AND actor_id=? AND type=? AND body=?',
      [adminId, student.id, n.type, n.body]
    );
    if (found) {
      await db.query('UPDATE notifications SET read_at=NULL, created_at=? WHERE id=?', [daysAgo(n.age), found.id]);
      console.log(`  = ${n.title}: ${n.body.slice(0, 32)}`);
    } else {
      await db.query(
        `INSERT INTO notifications (org_id, user_id, actor_id, type, title, body, ref_id, read_at, created_at)
         VALUES (?,?,?,?,?,?,?, NULL, ?)`,
        [org.id, adminId, student.id, n.type, n.title, n.body, student.id, daysAgo(n.age)]
      );
      console.log(`  + ${n.title}: ${n.body.slice(0, 32)}`);
    }
  }

  await db.end();

  console.log(`\nDone.\n\n  Log in as: ${ADMIN_EMAIL}\n  Password:  ${PASSWORD}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
