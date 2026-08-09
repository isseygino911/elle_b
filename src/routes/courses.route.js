const express = require('express');
const pool = require('../db/pool');
const { ROLES, CAN_MANAGE_COURSES } = require('../constants/roles');
const { requireAuth, requireCapability } = require('../middleware/auth');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { scopeFor } = require('../utils/scope');
const { assertStudentInScope } = require('../utils/students');
const {
  serializeCourse,
  loadCourseInScope,
  fetchEnrolledStudentIds
} = require('./courses.helpers');
const { insertNotification } = require('./notifications.helpers');
const {
  createCourseSchema,
  updateCourseSchema,
  enrollStudentSchema,
  courseIdParamSchema,
  enrollmentParamSchema,
  listCoursesQuerySchema,
  deleteCourseQuerySchema
} = require('../schemas/courses.schema');

const router = express.Router();

// POST /courses -- create.
router.post(
  '/',
  requireCapability(CAN_MANAGE_COURSES),
  validateBody(createCourseSchema),
  async (req, res, next) => {
    try {
      let adminId;

      if (req.user.role === ROLES.ADMIN) {
        // A teacher's course is always their own. An admin_id in the body is
        // ignored rather than rejected: it is the only value they could
        // legitimately have meant, and a 400 here would be pedantry. What
        // matters is that a supplied one can never take effect.
        adminId = req.user.id;
      } else {
        // Owner. They own no roster, so there is no default to fall back on --
        // an owner who omits admin_id is not expressing an intention the
        // server can guess.
        if (req.body.admin_id === undefined) {
          return res.status(400).json({
            status: 'error',
            message: 'admin_id is required when an owner creates a course'
          });
        }

        // The named teacher must be a teacher, and must be in the caller's own
        // organization. Both halves are load-bearing: without the role check an
        // owner could hang a course off a student or a manager, and without the
        // org check they could hand one to another tenant's teacher -- whose
        // students would then be enrollable through it.
        const [teacherRows] = await pool.query(
          'SELECT id FROM users WHERE id = ? AND org_id = ? AND role = ?',
          [req.body.admin_id, req.user.orgId, ROLES.ADMIN]
        );

        if (!teacherRows[0]) {
          return res.status(400).json({ status: 'error', message: 'Teacher not found' });
        }

        adminId = teacherRows[0].id;
      }

      const [result] = await pool.query(
        `INSERT INTO courses (org_id, admin_id, title, description)
         VALUES (?, ?, ?, ?)`,
        [req.user.orgId, adminId, req.body.title, req.body.description ?? null]
      );

      const [rows] = await pool.query(
        `SELECT c.*, u.name AS teacher_name
           FROM courses c
           JOIN users u ON u.id = c.admin_id
          WHERE c.id = ?`,
        [result.insertId]
      );

      res.status(201).json({ course: serializeCourse(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

// GET /courses -- list.
//
// requireAuth, not requireCapability: a student lists the courses they are
// enrolled in, and they are (correctly) absent from CAN_MANAGE_COURSES. The
// manager is turned away explicitly below rather than by the middleware.
router.get(
  '/',
  requireAuth(),
  validateQuery(listCoursesQuerySchema),
  async (req, res, next) => {
    try {
      // A manager reaching a course list would be reading a membership roster
      // of named students. scopeFor throws for them anyway; this returns the
      // clean 403 rather than letting the error handler render a ScopeError.
      if (!CAN_MANAGE_COURSES.has(req.user.role) && req.user.role !== ROLES.STUDENT) {
        return res.status(403).json({ status: 'error', message: 'Forbidden' });
      }

      const conditions = [];
      const params = [];

      if (req.user.role === ROLES.STUDENT) {
        // See loadCourseInScope for why a student is a join rather than a
        // scopeFor branch.
        conditions.push('c.org_id = ?');
        params.push(req.user.orgId);
        conditions.push(
          'EXISTS (SELECT 1 FROM course_enrollments e WHERE e.course_id = c.id AND e.student_id = ?)'
        );
        params.push(req.user.id);
      } else {
        const scope = scopeFor(req.user, { org: 'c.org_id', admin: 'c.admin_id' });
        conditions.push(scope.sql);
        params.push(...scope.params);
      }

      // Unfiltered means active only. An archived course is finished business,
      // and a default that included it would make every teacher's list grow
      // without bound. `?status=archived` reaches them deliberately.
      conditions.push('c.status = ?');
      params.push(req.query.status ?? 'active');

      const [rows] = await pool.query(
        `SELECT c.*, u.name AS teacher_name,
                (SELECT COUNT(*) FROM course_enrollments e WHERE e.course_id = c.id)
                  AS student_count
           FROM courses c
           JOIN users u ON u.id = c.admin_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY c.created_at DESC, c.id DESC`,
        params
      );

      res.status(200).json({ courses: rows.map(serializeCourse) });
    } catch (err) {
      next(err);
    }
  }
);

// GET /courses/:id -- detail, with the enrolled students.
router.get(
  '/:id',
  requireAuth(),
  validateParams(courseIdParamSchema),
  async (req, res, next) => {
    try {
      if (!CAN_MANAGE_COURSES.has(req.user.role) && req.user.role !== ROLES.STUDENT) {
        return res.status(403).json({ status: 'error', message: 'Forbidden' });
      }

      const course = await loadCourseInScope(req.user, req.params.id);

      if (!course) {
        return res.status(404).json({ status: 'error', message: 'Course not found' });
      }

      // The roster is the teaching side's view. A student enrolled in a course
      // may see the course, never the list of who else is in it -- that is a
      // set of named students they have no relationship with, and Elle's
      // one-to-one studios make a classmate list meaningless as well as
      // leaky.
      let students = [];
      if (CAN_MANAGE_COURSES.has(req.user.role)) {
        const [rows] = await pool.query(
          `SELECT u.id, u.name, u.email, e.created_at AS enrolled_at
             FROM course_enrollments e
             JOIN users u ON u.id = e.student_id
            WHERE e.course_id = ?
            ORDER BY u.name ASC, u.id ASC`,
          [course.id]
        );
        students = rows;
      }

      res.status(200).json({
        course: serializeCourse({ ...course, student_count: students.length }),
        students
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /courses/:id -- rename, re-describe, archive.
router.patch(
  '/:id',
  requireCapability(CAN_MANAGE_COURSES),
  validateParams(courseIdParamSchema),
  validateBody(updateCourseSchema),
  async (req, res, next) => {
    try {
      // Scope check before the write, not as part of it. An UPDATE with the
      // fence in its WHERE clause would answer affectedRows = 0 for both "not
      // yours" and "you changed nothing", and MariaDB reports a no-op update as
      // 0 rows affected -- so re-saving an unchanged title would 404.
      const course = await loadCourseInScope(req.user, req.params.id);

      if (!course) {
        return res.status(404).json({ status: 'error', message: 'Course not found' });
      }

      const assignments = [];
      const params = [];

      for (const field of ['title', 'description', 'status']) {
        if (req.body[field] !== undefined) {
          assignments.push(`${field} = ?`);
          params.push(req.body[field]);
        }
      }

      // The schema's refine guarantees at least one field, so `assignments` is
      // never empty here -- no empty-SET SQL can be built.
      await pool.query(
        `UPDATE courses SET ${assignments.join(', ')} WHERE id = ? AND org_id = ?`,
        [...params, course.id, req.user.orgId]
      );

      const [rows] = await pool.query(
        `SELECT c.*, u.name AS teacher_name
           FROM courses c
           JOIN users u ON u.id = c.admin_id
          WHERE c.id = ?`,
        [course.id]
      );

      res.status(200).json({ course: serializeCourse(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

// POST /courses/:id/enrollments -- add a student to the course.
router.post(
  '/:id/enrollments',
  requireCapability(CAN_MANAGE_COURSES),
  validateParams(courseIdParamSchema),
  validateBody(enrollStudentSchema),
  async (req, res, next) => {
    try {
      const course = await loadCourseInScope(req.user, req.params.id);

      if (!course) {
        return res.status(404).json({ status: 'error', message: 'Course not found' });
      }

      // ENROLLMENT GRANTS ACCESS. IT DOES NOT REQUIRE PRE-EXISTING ACCESS.
      //
      // This is the whole point of course_enrollments existing as a table, and
      // it is worth stating plainly because the obvious-looking alternative is
      // wrong in a way that is expensive to undo later.
      //
      // The tempting check here is `student.admin_id === course.admin_id` --
      // "the student must already be on this course's teacher's roster". It
      // reads like a safety property. It is actually a modelling error, because
      // users.admin_id is SINGLE-VALUED: a student has exactly one teacher. So
      // that check constrains a course to contain the students of exactly one
      // teacher, which:
      //
      //   - makes this table redundant (the roster would be derivable as
      //     `WHERE admin_id = course.admin_id`, and 0031's header explains at
      //     length why membership and roster are different sets);
      //   - makes a group class -- two teachers co-teaching, or a theory class
      //     drawing from several rosters -- unrepresentable. The app already
      //     has "class video" content owned by the org rather than one student,
      //     so group teaching is not hypothetical here;
      //   - permanently locks out a student with admin_id = NULL, since NULL
      //     never equals anything.
      //
      // A course is the thing that says who is doing this homework. Enrolling a
      // student into it is what grants that course's teacher access to the work
      // they submit. Requiring the access to exist first inverts that.
      // The tenancy fence, and the teacher's own limit. A teacher passes only
      // for students on their roster, so a teacher still cannot pull another
      // teacher's student into their course. What changed above is that they
      // may now enroll a student of theirs into ANY course they can reach, and
      // an owner may enroll any student in the organization.
      const student = await assertStudentInScope(req.user, req.body.student_id);

      if (!student) {
        return res.status(403).json({ status: 'error', message: 'Forbidden' });
      }

      // An owner enrolling a student into a course taught by someone else is
      // the one case that grants a THIRD party access: the course's teacher
      // gains the ability to read and review that student's submissions, and
      // neither of them asked for it.
      //
      // It is permitted -- an owner assigning a student to a group class is
      // ordinary administration, and forbidding it is what broke the model in
      // the first place -- but it is not allowed to be silent. The teacher is
      // notified that a student they do not otherwise teach now appears on
      // their course, which is the visible, deliberate act that replaces the
      // old blanket refusal.
      //
      // One comparison, not two. An earlier version also tested
      // `course.admin_id !== req.user.id` to avoid notifying an actor about
      // their own action -- but that branch is unreachable and was proven so by
      // mutation: assertStudentInScope limits a TEACHER to students where
      // student.admin_id === their own id, so whenever a teacher acts on their
      // own course both sides of this comparison are already equal. An owner is
      // never a course's admin_id (courses.admin_id must name a teacher, checked
      // at create). Keeping the clause meant carrying a condition no test could
      // ever make true, which is how dead defensive code accumulates.
      const grantsForeignAccess = Number(student.admin_id) !== Number(course.admin_id);

      // Transactional because the enrollment may carry a notification, and the
      // two must land together or not at all -- the tasks.route.js precedent.
      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        await connection.query(
          `INSERT INTO course_enrollments (org_id, course_id, student_id) VALUES (?, ?, ?)`,
          [req.user.orgId, course.id, student.id]
        );

        if (grantsForeignAccess) {
          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId: course.admin_id,
            actorId: req.user.id,
            type: 'course_enrolled',
            title: `${student.name} was added to ${course.title}`,
            body: 'You can now see the work they submit for this course.',
            refId: course.id
          });
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();

        // The unique key doing its job. 0031's header argues why this is a key
        // and not a SELECT-then-INSERT: two concurrent enrolls would both read
        // "not enrolled" and both write, and the student would then be notified
        // twice for every assignment published.
        if (err.code === 'ER_DUP_ENTRY') {
          return res
            .status(409)
            .json({ status: 'error', message: 'Student is already enrolled' });
        }
        return next(err);
      } finally {
        connection.release();
      }

      res.status(201).json({
        enrollment: {
          course_id: course.id,
          student_id: student.id,
          student_name: student.name
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /courses/:id/enrollments/:studentId -- remove a student.
//
// The enrollment row goes; the student's SUBMISSIONS do not. Those hang off
// assignments, not off this table (0031's header), so unenrolling stops future
// homework reaching them without erasing the work they already did.
router.delete(
  '/:id/enrollments/:studentId',
  requireCapability(CAN_MANAGE_COURSES),
  validateParams(enrollmentParamSchema),
  async (req, res, next) => {
    try {
      const course = await loadCourseInScope(req.user, req.params.id);

      if (!course) {
        return res.status(404).json({ status: 'error', message: 'Course not found' });
      }

      // org_id is on the predicate as well as course_id. The course is already
      // proven in-scope, so this is belt-and-braces -- but every write in this
      // codebase carries the tenancy fence explicitly rather than inheriting it
      // from a check further up the function.
      const [result] = await pool.query(
        'DELETE FROM course_enrollments WHERE course_id = ? AND student_id = ? AND org_id = ?',
        [course.id, req.params.studentId, req.user.orgId]
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ status: 'error', message: 'Enrollment not found' });
      }

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /courses/:id -- hard delete, with a confirmation gate.
//
// ARCHIVE VS DELETE
// PATCH status='archived' is still the normal way to retire a finished course:
// it keeps every assignment, submission and enrollment and simply drops out of
// the default list. This endpoint is for a course that should never have
// existed -- wrong organization, a duplicate, a test row -- where leaving it
// archived forever is just clutter.
//
// ONLY THE CREATOR
// requireCapability(CAN_MANAGE_COURSES) admits owners and teachers; this
// endpoint narrows that to the course's own admin_id. An owner may create a
// course (naming a teacher), read it, edit it and archive it, but may not
// destroy another person's authored work along with its students' submissions.
// Deleting is the one verb reserved to whoever created the thing.
//
// WHY THE ROW TEARDOWN IS ONE STATEMENT
// courses -> assignments -> submissions -> submission_files are all ON DELETE
// CASCADE, as is course_enrollments. A single DELETE removes the whole tree
// atomically and in the correct order. Hand-rolling that loop table by table
// would be slower, would race, and would silently miss any table added later.
//
// What the cascade CANNOT do is the two things this route does by hand:
//   1. notifications.ref_id has no foreign key (0007's header: one column
//      cannot reference six tables), so every notification pointing at this
//      course or its assignments would survive as a dangling link to a 404.
//   2. Nobody is told. The students whose work is about to be destroyed need
//      to hear it from the app, not discover it as a missing page.
//
// S3 OBJECTS ARE NOT YET CLEANED UP -- KNOWN GAP, PHASE 4
// submission_files rows cascade away with the course, but the objects they
// point at stay in the bucket and become unreferenced. The upload path and its
// s3.deleteSubmissionObject helper do not exist yet (Phase 4), so there is
// nothing to call; today the cascade never has files to orphan because nothing
// can create them. Phase 4 must collect s3_key values alongside assignmentIds
// below and delete the objects AFTER the commit, best-effort, per the
// library.route.js posture -- but INVERTED relative to that precedent:
// library deletes the object first because a single failed row-delete leaves
// one broken file, whereas here a rollback after deleting objects would leave
// many surviving rows pointing at nothing. Orphaned objects cost storage;
// orphaned rows lose data.
router.delete(
  '/:id',
  requireCapability(CAN_MANAGE_COURSES),
  validateParams(courseIdParamSchema),
  validateQuery(deleteCourseQuerySchema),
  async (req, res, next) => {
    try {
      const course = await loadCourseInScope(req.user, req.params.id);

      if (!course) {
        return res.status(404).json({ status: 'error', message: 'Course not found' });
      }

      // 403 rather than 404: the caller can legitimately SEE this course (they
      // just did), so pretending it does not exist would be a lie that makes
      // the UI harder to write. The refusal is about the verb, not the row.
      if (Number(course.admin_id) !== Number(req.user.id)) {
        return res.status(403).json({
          status: 'error',
          message: 'Only the teacher who created a course may delete it. Archive it instead.'
        });
      }

      // Everything below must be gathered BEFORE the delete. Once the cascade
      // fires there is nothing left to query -- the assignments, the
      // submissions and the enrollments are gone in the same statement.
      const [assignmentRows] = await pool.query(
        'SELECT id FROM assignments WHERE course_id = ? AND org_id = ?',
        [course.id, req.user.orgId]
      );
      const assignmentIds = assignmentRows.map((row) => row.id);

      // TWO DIFFERENT SETS, for two different jobs.
      //
      // Everyone ENROLLED is notified: the course was on their dashboard and in
      // their course list, and if it silently disappears they are left to work
      // out for themselves whether it was deleted, hidden, or a bug. Losing no
      // files is not the same as nothing having happened to them.
      //
      // Only the students who SUBMITTED drive the confirmation gate and the
      // wording of their own notification, because they are the ones whose
      // authored work is actually destroyed.
      const enrolledStudentIds = await fetchEnrolledStudentIds(course.id);

      const [submitterRows] = assignmentIds.length
        ? await pool.query(
            `SELECT s.student_id, COUNT(*) AS submission_count
               FROM submissions s
              WHERE s.assignment_id IN (?) AND s.org_id = ?
              GROUP BY s.student_id`,
            [assignmentIds, req.user.orgId]
          )
        : [[]];

      const submissionsByStudent = new Map(
        submitterRows.map((row) => [Number(row.student_id), Number(row.submission_count)])
      );

      const submissionCount = submitterRows.reduce(
        (total, row) => total + Number(row.submission_count),
        0
      );

      // THE CONFIRMATION GATE.
      //
      // Only when real work would be destroyed. Deleting an empty course, or
      // one whose students never submitted, is not a destructive act worth
      // interrupting -- a gate that fires on every delete trains people to
      // click through it, which is worse than no gate.
      if (submissionCount > 0 && req.query.confirm !== 'true') {
        return res.status(409).json({
          status: 'error',
          message:
            'This course has submitted work that will be permanently deleted. Re-send with confirm=true to proceed.',
          confirmation_required: true,
          submission_count: submissionCount,
          // The count that belongs in a "are you sure" prompt is how many
          // people lose work, not how many are enrolled.
          student_count: submissionsByStudent.size,
          enrolled_count: enrolledStudentIds.length,
          assignment_count: assignmentIds.length
        });
      }

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        // Tell the students first, while their user ids are still known -- the
        // cascade below erases course_enrollments, so after it there is no way
        // left to ask who was in this course.
        //
        // These notifications outlive the course they describe, which is the
        // point: for a student who submitted, this is the only record they will
        // have that the work existed.
        for (const studentId of enrolledStudentIds) {
          const submitted = submissionsByStudent.get(Number(studentId)) ?? 0;

          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId: studentId,
            actorId: req.user.id,
            type: 'course_deleted',
            title: `${course.title} was deleted`,
            // Two wordings, because the two situations genuinely differ and a
            // single message would be wrong for one of them. Telling a student
            // who never submitted that "your work has been removed" is false
            // and alarming; telling one who did that the course merely "is no
            // longer available" understates what happened to their work.
            body: submitted
              ? 'The work you submitted for this course has been removed.'
              : 'This course is no longer available.',
            refId: course.id
          });
        }

        // Clear the notifications that pointed INTO this course, or they become
        // links to a 404. Scoped by (type, ref_id) pairs because ref_id is
        // meaningless without its type -- assignment id 7 and course id 7 are
        // different things.
        //
        // course_deleted is deliberately NOT in either list: those rows were
        // just written above and must outlive the course.
        if (assignmentIds.length) {
          await connection.query(
            `DELETE FROM notifications
              WHERE org_id = ?
                AND type IN ('assignment_published', 'submission_received', 'submission_reviewed')
                AND ref_id IN (?)`,
            [req.user.orgId, assignmentIds]
          );
        }

        await connection.query(
          "DELETE FROM notifications WHERE org_id = ? AND type = 'course_enrolled' AND ref_id = ?",
          [req.user.orgId, course.id]
        );

        // One statement. The FK cascade takes course_enrollments, assignments,
        // submissions and submission_files with it.
        const [result] = await connection.query(
          'DELETE FROM courses WHERE id = ? AND org_id = ?',
          [course.id, req.user.orgId]
        );

        if (result.affectedRows === 0) {
          await connection.rollback();
          return res.status(404).json({ status: 'error', message: 'Course not found' });
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      res.status(200).json({
        status: 'ok',
        deleted: {
          course_id: course.id,
          assignment_count: assignmentIds.length,
          submission_count: submissionCount,
          notified_student_count: enrolledStudentIds.length
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
