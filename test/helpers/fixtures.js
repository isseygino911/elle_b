'use strict';

// Seeds a two-organization world.
//
// WHY TWO ORGS
// One org can prove that a teacher sees their own students. Only a second org
// can prove they cannot see anyone else's. Every tenancy fence in this codebase
// -- scopeFor, assertStudentInScope, the org_id predicates -- is a claim about
// what happens ACROSS that line, and a single-org fixture cannot test any of
// them. Org B exists to be the place nothing should ever reach.
//
// SHAPE
//   Org A ("Studio A")           Org B ("Studio B")
//     owner                        owner
//     manager                      admin      (teacher)
//     teacher1 -> student1a,          student  (assigned to org B's admin)
//                 student1b
//     teacher2 -> student2a
//     orphanStudent (admin_id NULL -- the unassigned case, BUG C)
//
// teacher1 having TWO students matters: it distinguishes "sees their roster"
// from "sees exactly one row". teacher2 exists so a peer teacher's data is
// present to be wrongly returned by a broken scope. orphanStudent has no
// teacher at all, which is the case notifications silently drop today.
//
// Migration 0016 seeds organization id=1 ('Elle Coaching'). These fixtures let
// AUTO_INCREMENT assign fresh ids rather than reusing it, so no test depends on
// that row and truncation between tests cannot resurrect a half-real org.

const { ROLES } = require('../../src/constants/roles');

// Fixed, obviously-fake hash. Nothing in these tests authenticates by
// password -- tokens are minted directly (see auth.js) -- so this only needs to
// satisfy the NOT NULL-ness of the column where present.
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$dGVzdHNhbHR0ZXN0c2E$test';

async function insertOrg(pool, name) {
  const [result] = await pool.query('INSERT INTO organizations (name) VALUES (?)', [name]);
  return { id: result.insertId, name };
}

async function insertUser(pool, { orgId, role, name, email, adminId = null }) {
  const [result] = await pool.query(
    'INSERT INTO users (org_id, role, name, email, password_hash, admin_id) VALUES (?, ?, ?, ?, ?, ?)',
    [orgId, role, name, email, PASSWORD_HASH, adminId]
  );

  // Returned shape matches what test/helpers/auth.js expects, so a fixture row
  // can be handed straight to tokenFor().
  return { id: result.insertId, orgId, role, name, email, adminId };
}

async function seedTwoOrgs(pool) {
  const orgA = await insertOrg(pool, 'Studio A');
  const orgB = await insertOrg(pool, 'Studio B');

  const ownerA = await insertUser(pool, {
    orgId: orgA.id,
    role: ROLES.OWNER,
    name: 'Owner A',
    email: 'owner-a@test.local'
  });

  const managerA = await insertUser(pool, {
    orgId: orgA.id,
    role: ROLES.MANAGER,
    name: 'Manager A',
    email: 'manager-a@test.local'
  });

  const teacher1 = await insertUser(pool, {
    orgId: orgA.id,
    role: ROLES.ADMIN,
    name: 'Teacher One',
    email: 'teacher1-a@test.local'
  });

  const teacher2 = await insertUser(pool, {
    orgId: orgA.id,
    role: ROLES.ADMIN,
    name: 'Teacher Two',
    email: 'teacher2-a@test.local'
  });

  const student1a = await insertUser(pool, {
    orgId: orgA.id,
    role: ROLES.STUDENT,
    name: 'Student One A',
    email: 'student1a@test.local',
    adminId: teacher1.id
  });

  const student1b = await insertUser(pool, {
    orgId: orgA.id,
    role: ROLES.STUDENT,
    name: 'Student One B',
    email: 'student1b@test.local',
    adminId: teacher1.id
  });

  const student2a = await insertUser(pool, {
    orgId: orgA.id,
    role: ROLES.STUDENT,
    name: 'Student Two A',
    email: 'student2a@test.local',
    adminId: teacher2.id
  });

  // No owning teacher. resolveCounterparty returns null for this student, so
  // their actions notify nobody -- intended today, but applied inconsistently
  // across routes (BUG C).
  const orphanStudent = await insertUser(pool, {
    orgId: orgA.id,
    role: ROLES.STUDENT,
    name: 'Orphan Student',
    email: 'orphan@test.local',
    adminId: null
  });

  const ownerB = await insertUser(pool, {
    orgId: orgB.id,
    role: ROLES.OWNER,
    name: 'Owner B',
    email: 'owner-b@test.local'
  });

  const teacherB = await insertUser(pool, {
    orgId: orgB.id,
    role: ROLES.ADMIN,
    name: 'Teacher B',
    email: 'teacher-b@test.local'
  });

  const studentB = await insertUser(pool, {
    orgId: orgB.id,
    role: ROLES.STUDENT,
    name: 'Student B',
    email: 'student-b@test.local',
    adminId: teacherB.id
  });

  return {
    orgA: { ...orgA, owner: ownerA, manager: managerA, teacher1, teacher2, student1a, student1b, student2a, orphanStudent },
    orgB: { ...orgB, owner: ownerB, teacher: teacherB, student: studentB }
  };
}

module.exports = { seedTwoOrgs, insertOrg, insertUser, PASSWORD_HASH };
