const express = require('express');
const pool = require('../db/pool');
const { ROLES, CAN_MANAGE_COURSES } = require('../constants/roles');
const { requireAuth, requireCapability } = require('../middleware/auth');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { loadCourseInScope, fetchEnrolledStudentIds } = require('./courses.helpers');
const { serializeAssignment } = require('./assignments.helpers');
const { insertNotification } = require('./notifications.helpers');
const {
  createAssignmentSchema,
  updateAssignmentSchema,
  courseIdParamSchema,
  assignmentInCourseParamSchema,
  listAssignmentsQuerySchema
} = require('../schemas/assignments.schema');

// mergeParams so :courseId from the parent mount is visible here, following
// the /videos/:id/comments precedent.
const router = express.Router({ mergeParams: true });

// A manager must never reach an assignment: it is addressed to named students,
// and its submissions are their work. They are absent from CAN_MANAGE_COURSES
// for that reason, but the two GET routes below are requireAuth() rather than
// requireCapability -- a student must reach them, and a student is also
// (correctly) absent from that set. So the manager is turned away explicitly.
//
// This is the OUTER of two layers, and deliberately redundant: scopeFor's
// manager branch throws a ScopeError (status 403, rendered by app.js's fallback
// handler) one layer down, so deleting this function would not open a hole
// today -- verified by mutation, the suite stays green without it.
//
// It is kept because the inner layer is incidental rather than intentional. A
// future endpoint here that does not reach scopeFor -- a COUNT, an aggregate,
// anything phrased so the manager branch is never evaluated -- would have no
// boundary at all. Stating the rule where the rule belongs means that endpoint
// inherits it instead of silently omitting it.
function managerRefused(user) {
  return !CAN_MANAGE_COURSES.has(user.role) && user.role !== ROLES.STUDENT;
}

// Resolves the parent course, or writes the response and returns null.
//
// Every endpoint in this file begins here. An assignment is only ever reachable
// through a course the caller may already see, so the course check is the whole
// authorization boundary -- there is no second, assignment-specific rule to get
// wrong.
async function requireCourse(req, res, executor = pool) {
  if (managerRefused(req.user)) {
    res.status(403).json({ status: 'error', message: 'Forbidden' });
    return null;
  }

  const course = await loadCourseInScope(req.user, req.params.courseId, executor);

  if (!course) {
    res.status(404).json({ status: 'error', message: 'Course not found' });
    return null;
  }

  return course;
}

// Which accepts_* flags an assignment would have after a patch is applied.
//
// 0032's header requires at least one to be true and argues why the rule lives
// in the route: on PATCH the flags arrive partially, so the answer depends on
// the row already in the database. Merging first, then checking once, is what
// makes a partial update as safe as a create.
function mergeAcceptsFlags(current, body) {
  return {
    accepts_text: body.accepts_text ?? current.accepts_text,
    accepts_files: body.accepts_files ?? current.accepts_files,
    accepts_recording: body.accepts_recording ?? current.accepts_recording
  };
}

function acceptsNothing(flags) {
  return !flags.accepts_text && !flags.accepts_files && !flags.accepts_recording;
}

const ACCEPTS_NOTHING_MESSAGE =
  'An assignment must accept at least one of text, files or a recording';

// POST /courses/:courseId/assignments -- create, always as a draft.
//
// There is no create-and-publish in one call. Publishing notifies every
// enrolled student, and an accidental double-POST would then be indistinguish-
// able from a real second assignment. Draft-then-PATCH makes the notifying step
// its own deliberate act, and the FOR UPDATE read there makes it idempotent.
router.post(
  '/',
  requireCapability(CAN_MANAGE_COURSES),
  validateParams(courseIdParamSchema),
  validateBody(createAssignmentSchema),
  async (req, res, next) => {
    try {
      const course = await requireCourse(req, res);
      if (!course) {
        return;
      }

      // Defaults mirror the column defaults in 0032 rather than being re-chosen
      // here, so a teacher who sends no flags gets exactly what the schema
      // documents: text and files on, recording off.
      const flags = {
        accepts_text: req.body.accepts_text ?? true,
        accepts_files: req.body.accepts_files ?? true,
        accepts_recording: req.body.accepts_recording ?? false
      };

      if (acceptsNothing(flags)) {
        return res.status(400).json({ status: 'error', message: ACCEPTS_NOTHING_MESSAGE });
      }

      const [result] = await pool.query(
        `INSERT INTO assignments
           (org_id, course_id, title, body, reference_url, due_date, allowed_attempts,
            accepts_text, accepts_files, accepts_recording, max_recording_sec, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.orgId,
          course.id,
          req.body.title,
          req.body.body ?? null,
          req.body.reference_url ?? null,
          req.body.due_date ?? null,
          req.body.allowed_attempts ?? null,
          flags.accepts_text,
          flags.accepts_files,
          flags.accepts_recording,
          req.body.max_recording_sec ?? 300,
          req.user.id
        ]
      );

      const [rows] = await pool.query('SELECT * FROM assignments WHERE id = ?', [result.insertId]);

      res.status(201).json({ assignment: serializeAssignment(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

// GET /courses/:courseId/assignments -- list for the course.
router.get(
  '/',
  requireAuth(),
  validateParams(courseIdParamSchema),
  validateQuery(listAssignmentsQuerySchema),
  async (req, res, next) => {
    try {
      const course = await requireCourse(req, res);
      if (!course) {
        return;
      }

      const conditions = ['a.course_id = ?', 'a.org_id = ?'];
      const params = [course.id, req.user.orgId];

      if (req.user.role === ROLES.STUDENT) {
        // Not negotiable, and deliberately not driven by req.query.status: a
        // draft is a teacher's unfinished thinking. A student asking for
        // ?status=draft gets published anyway rather than an error, because the
        // existence of drafts is itself not their business.
        conditions.push("a.status = 'published'");
      } else if (req.query.status) {
        conditions.push('a.status = ?');
        params.push(req.query.status);
      }

      const [rows] = await pool.query(
        `SELECT a.* FROM assignments a
          WHERE ${conditions.join(' AND ')}
          ORDER BY a.due_date IS NULL, a.due_date ASC, a.id ASC`,
        params
      );

      res.status(200).json({ assignments: rows.map(serializeAssignment) });
    } catch (err) {
      next(err);
    }
  }
);

// GET /courses/:courseId/assignments/:id -- detail.
router.get(
  '/:id',
  requireAuth(),
  validateParams(assignmentInCourseParamSchema),
  async (req, res, next) => {
    try {
      const course = await requireCourse(req, res);
      if (!course) {
        return;
      }

      // course_id is on the predicate as well as id. Without it, an assignment
      // id from another course would be readable as long as the caller could
      // see ANY course -- the :courseId in the path would be decorative.
      const [rows] = await pool.query(
        'SELECT * FROM assignments WHERE id = ? AND course_id = ? AND org_id = ?',
        [req.params.id, course.id, req.user.orgId]
      );

      const assignment = rows[0];

      // A draft is invisible to a student, and invisible means 404 rather than
      // 403 -- consistent with every other read in this codebase, and it keeps
      // a student from learning that unpublished homework exists.
      if (!assignment || (req.user.role === ROLES.STUDENT && assignment.status !== 'published')) {
        return res.status(404).json({ status: 'error', message: 'Assignment not found' });
      }

      res.status(200).json({ assignment: serializeAssignment(assignment) });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /courses/:courseId/assignments/:id -- edit, publish, and retract.
//
// Both status transitions do work beyond the column, and both do it inside the
// same transaction as the status write:
//
//   draft -> published   fans out a notification to every enrolled student. If
//                        one fails (insertNotification throws for a recipient
//                        outside the org) the publish rolls back with it -- an
//                        assignment that could not be correctly announced is
//                        not left silently published.
//
//   published -> draft   deletes those notifications, so the assignment leaves
//                        no trace on a student's list. Refused with 409 if any
//                        submission exists; see the check below.
router.patch(
  '/:id',
  requireCapability(CAN_MANAGE_COURSES),
  validateParams(assignmentInCourseParamSchema),
  validateBody(updateAssignmentSchema),
  async (req, res, next) => {
    try {
      const course = await requireCourse(req, res);
      if (!course) {
        return;
      }

      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        // Read BEFORE the update, and lock the row. The tasks.route.js idiom.
        //
        // Two things depend on the previous value. The accepts_* merge needs
        // the flags already stored, and -- the important one -- only the
        // transition INTO 'published' is an event. A teacher who publishes,
        // then fixes a typo and saves again, must not notify twice.
        //
        // FOR UPDATE because between this read and the UPDATE another request
        // could otherwise publish the same assignment, and both would see
        // 'draft' as the previous status and both would fan out.
        const [beforeRows] = await connection.query(
          'SELECT * FROM assignments WHERE id = ? AND course_id = ? AND org_id = ? FOR UPDATE',
          [req.params.id, course.id, req.user.orgId]
        );
        const before = beforeRows[0];

        if (!before) {
          await connection.rollback();
          return res.status(404).json({ status: 'error', message: 'Assignment not found' });
        }

        if (acceptsNothing(mergeAcceptsFlags(before, req.body))) {
          await connection.rollback();
          return res.status(400).json({ status: 'error', message: ACCEPTS_NOTHING_MESSAGE });
        }

        const justRetracted = req.body.status === 'draft' && before.status === 'published';

        // Retracting is allowed -- publishing to the wrong course, or before the
        // instruction was finished, are ordinary mistakes and the fix should not
        // require deleting the assignment and retyping it.
        //
        // The exception is work that already exists. A submission is attached to
        // this assignment; hiding it would leave the student looking at homework
        // they can no longer open, and the teacher unable to review what they
        // sent. Nothing is destroyed here -- the teacher is told to edit in
        // place, or archive the course, instead.
        if (justRetracted) {
          const [submissionRows] = await connection.query(
            'SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ?',
            [before.id]
          );

          if (Number(submissionRows[0].count) > 0) {
            await connection.rollback();
            return res.status(409).json({
              status: 'error',
              message:
                'Students have already submitted work for this assignment. Edit it in place, or archive the course, rather than retracting it.'
            });
          }
        }

        const assignments = [];
        const params = [];

        for (const field of [
          'title',
          'body',
          'reference_url',
          'due_date',
          'allowed_attempts',
          'accepts_text',
          'accepts_files',
          'accepts_recording',
          'max_recording_sec',
          'status'
        ]) {
          if (req.body[field] !== undefined) {
            assignments.push(`${field} = ?`);
            params.push(req.body[field]);
          }
        }

        // The schema's refine guarantees at least one field, so no empty-SET
        // SQL can be built.
        await connection.query(
          `UPDATE assignments SET ${assignments.join(', ')} WHERE id = ? AND org_id = ?`,
          [...params, before.id, req.user.orgId]
        );

        const justPublished = req.body.status === 'published' && before.status !== 'published';

        if (justPublished) {
          // Read inside the transaction: the recipients are the students
          // enrolled at the moment the status flipped.
          const studentIds = await fetchEnrolledStudentIds(course.id, connection);

          if (studentIds.length === 0) {
            // The videos.route.js no-recipients precedent. Publishing to an
            // empty course is legitimate -- a teacher may set up homework
            // before enrolling anyone -- but a silent no-op is indistinguish-
            // able from delivery, and this is the line that tells the two
            // apart when a teacher reports that nobody was told.
            console.warn(
              `[notifications] assignment ${before.id} published into course ${course.id} ` +
                `with no enrolled students (actor ${req.user.id})`
            );
          }

          const title = req.body.title ?? before.title;
          const dueDate = req.body.due_date !== undefined ? req.body.due_date : before.due_date;
          const formatted = serializeAssignment({ ...before, due_date: dueDate }).due_date;

          for (const studentId of studentIds) {
            await insertNotification(connection, {
              orgId: req.user.orgId,
              userId: studentId,
              actorId: req.user.id,
              type: 'assignment_published',
              title: `New homework: ${title}`,
              body: formatted ? `Due ${formatted}` : null,
              refId: before.id
            });
          }
        }

        if (justRetracted) {
          // Delete rather than leave orphaned. This is the only place in the
          // codebase that removes a notification -- everywhere else they are
          // marked read and kept -- and the reason is that the others describe
          // something that HAPPENED (a comment was left, a booking was made),
          // which stays true forever. This one describes something that is
          // CURRENTLY TRUE: homework is waiting for you. Once it is retracted
          // that is a false statement, and a "New homework" line linking to an
          // assignment the student can no longer open is worse than no line.
          //
          // Scoped to this assignment's own type and ref_id so it cannot reach
          // any other notification. org_id is on the predicate as the tenancy
          // fence, matching every other write here.
          await connection.query(
            "DELETE FROM notifications WHERE type = 'assignment_published' AND ref_id = ? AND org_id = ?",
            [before.id, req.user.orgId]
          );
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      const [rows] = await pool.query('SELECT * FROM assignments WHERE id = ? AND org_id = ?', [
        req.params.id,
        req.user.orgId
      ]);

      res.status(200).json({ assignment: serializeAssignment(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
