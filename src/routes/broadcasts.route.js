const express = require('express');
const pool = require('../db/pool');
const {
  ROLES,
  CAN_BROADCAST_ORG,
  CAN_BROADCAST_ROSTER,
  CAN_READ_BROADCAST_OVERSIGHT
} = require('../constants/roles');
const { requireAuth } = require('../middleware/auth');
const { validateBody, validateQuery } = require('../middleware/validate');
const { createBroadcastSchema, listBroadcastsQuerySchema } = require('../schemas/broadcasts.schema');
const { insertNotification } = require('./notifications.helpers');

const router = express.Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

// Resolves who a broadcast actually reaches, as a list of user ids.
//
// Runs on the transaction connection, not the pool: the recipient set and the
// recipient_count written alongside it must describe the same instant. Reading
// the roster from the pool while the insert ran in a transaction would let a
// student added mid-send be counted but not notified, or the reverse.
//
// Every query here is fenced on org_id. The caller's own org comes from a
// verified token claim, so this is the tenancy boundary for the whole feature.
async function resolveBroadcastRecipients(connection, { actor, audience }) {
  if (CAN_BROADCAST_ORG.has(actor.role)) {
    // Org-wide. The role filter is an explicit IN list rather than a rank
    // comparison: 'both' means teachers and students, and must NOT sweep up
    // managers or the owner. A rank-based "everyone below me" would include
    // both, which is how an owner ends up notifying themselves.
    const roles =
      audience === 'both'
        ? [ROLES.ADMIN, ROLES.STUDENT]
        : audience === 'teachers'
          ? [ROLES.ADMIN]
          : [ROLES.STUDENT];

    const [rows] = await connection.query(
      `SELECT id FROM users WHERE org_id = ? AND role IN (?) AND id != ? ORDER BY id`,
      [actor.orgId, roles, actor.id]
    );

    return rows.map((row) => row.id);
  }

  // Teacher: their own roster, and only ever that. admin_id is the roster
  // edge, so this cannot address another teacher's students however the
  // audience field was set -- which is why the route's audience check below is
  // about honest recording, not about containment.
  const [rows] = await connection.query(
    `SELECT id FROM users
      WHERE org_id = ? AND role = ? AND admin_id = ?
      ORDER BY id`,
    [actor.orgId, ROLES.STUDENT, actor.id]
  );

  return rows.map((row) => row.id);
}

// The owner plus every manager, excluding the sender.
//
// Managers cannot send but must see that a send happened -- this is their
// aggregate tier applied to a new event. The owner is included because a
// teacher addressing students is org activity the owner oversees; when the
// owner is themselves the sender they are excluded by the id filter rather
// than by a role branch.
async function resolveOversightRecipients(connection, { actor }) {
  const [rows] = await connection.query(
    `SELECT id FROM users
      WHERE org_id = ? AND role IN (?) AND id != ?
      ORDER BY id`,
    [actor.orgId, [ROLES.OWNER, ROLES.MANAGER], actor.id]
  );

  return rows.map((row) => row.id);
}

function serializeBroadcast(row) {
  return {
    id: row.id,
    sender_id: row.sender_id,
    sender_name: row.sender_name ?? null,
    audience: row.audience,
    title: row.title,
    body: row.body,
    recipient_count: row.recipient_count,
    created_at: row.created_at
  };
}

router.post(
  '/',
  requireAuth(),
  validateBody(createBroadcastSchema),
  async (req, res, next) => {
    try {
      const canOrg = CAN_BROADCAST_ORG.has(req.user.role);
      const canRoster = CAN_BROADCAST_ROSTER.has(req.user.role);

      // Two positive allowlists, never a rank comparison. A manager outranks an
      // admin and is in neither set -- which is precisely the case
      // `rank >= admin` would get wrong, per constants/roles.js.
      if (!canOrg && !canRoster) {
        return res.status(403).json({ status: 'error', message: 'Forbidden' });
      }

      // A teacher's reach is their roster, so 'students' is the only audience
      // that describes what will happen. resolveBroadcastRecipients would
      // return the same roster regardless, so this is not what keeps a teacher
      // out of other people's students -- it stops the broadcasts row from
      // RECORDING an audience the send did not have. A row claiming
      // audience='both' next to a roster-sized recipient_count would be a
      // permanent, unfalsifiable lie in the manager's oversight view.
      if (!canOrg && req.body.audience !== 'students') {
        return res.status(403).json({
          status: 'error',
          message: 'Teachers may only broadcast to their own students'
        });
      }

      const connection = await pool.getConnection();
      let broadcastId;

      try {
        await connection.beginTransaction();

        const recipients = await resolveBroadcastRecipients(connection, {
          actor: req.user,
          audience: req.body.audience
        });

        // Reject rather than write a broadcast nobody receives. A teacher with
        // no students, or an owner whose org has no teachers yet, gets a clear
        // 400 instead of a sent-looking row with recipient_count = 0 sitting
        // in their outbox.
        //
        // Rolled back explicitly before returning: the transaction is already
        // open, and leaving it to the finally block would release a connection
        // with an open transaction back to the pool.
        if (recipients.length === 0) {
          await connection.rollback();
          return res.status(400).json({
            status: 'error',
            message: 'This broadcast would reach nobody'
          });
        }

        const [insertResult] = await connection.query(
          `INSERT INTO broadcasts (org_id, sender_id, audience, title, body, recipient_count)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            req.user.orgId,
            req.user.id,
            req.body.audience,
            req.body.title,
            req.body.body,
            recipients.length
          ]
        );
        broadcastId = insertResult.insertId;

        // Fan-out in the same transaction as the broadcast row. Studio rosters
        // are small (tens, not thousands), so a per-recipient INSERT is fine;
        // if one ever runs to several hundred this becomes a batched multi-row
        // INSERT. Not built for that now -- there is no such org.
        //
        // insertNotification re-checks each recipient's org against orgId, so
        // a resolver bug cannot write across a tenancy boundary even though
        // both queries above are already org-fenced.
        for (const userId of recipients) {
          await insertNotification(connection, {
            orgId: req.user.orgId,
            userId,
            actorId: req.user.id,
            type: 'broadcast',
            title: req.body.title,
            body: req.body.body,
            refId: broadcastId
          });
        }

        // Oversight copies, for a teacher's send only. An owner broadcasting
        // org-wide has already reached everyone they would be copying, and a
        // manager sitting in the 'teachers' audience would otherwise receive
        // the same announcement twice.
        if (!canOrg) {
          const oversightRecipients = await resolveOversightRecipients(connection, {
            actor: req.user
          });

          for (const userId of oversightRecipients) {
            await insertNotification(connection, {
              orgId: req.user.orgId,
              userId,
              actorId: req.user.id,
              type: 'broadcast',
              title: `Broadcast sent to ${recipients.length} student${recipients.length === 1 ? '' : 's'}`,
              // The announcement's own title, not its body. A manager may see
              // THAT a teacher messaged their roster and how far it reached;
              // the full text is between the teacher and their students.
              body: req.body.title,
              refId: broadcastId
            });
          }
        }

        await connection.commit();
      } catch (err) {
        await connection.rollback();
        return next(err);
      } finally {
        connection.release();
      }

      const [rows] = await pool.query(
        `SELECT b.*, u.name AS sender_name
           FROM broadcasts b
           JOIN users u ON u.id = b.sender_id
          WHERE b.id = ?`,
        [broadcastId]
      );

      res.status(201).json({ broadcast: serializeBroadcast(rows[0]) });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/',
  requireAuth(),
  validateQuery(listBroadcastsQuerySchema),
  async (req, res, next) => {
    try {
      const canOrg = CAN_BROADCAST_ORG.has(req.user.role);
      const canRoster = CAN_BROADCAST_ROSTER.has(req.user.role);
      const canOversee = CAN_READ_BROADCAST_OVERSIGHT.has(req.user.role);

      // A student's copy of a broadcast is the notification they already
      // receive; this endpoint is the SENDER's outbox and the overseer's feed.
      // Falling through to an empty list would read as "you have sent none"
      // rather than "this is not yours to read".
      if (!canOrg && !canRoster && !canOversee) {
        return res.status(403).json({ status: 'error', message: 'Forbidden' });
      }

      const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
      const offset = Number(req.query.offset) || 0;

      // Owner and manager see every broadcast in the org; a teacher sees only
      // their own. org_id is on the WHERE clause in both branches -- the
      // sender_id filter alone would already scope a teacher correctly, but
      // every read in this codebase carries the tenancy fence explicitly.
      const conditions = ['b.org_id = ?'];
      const params = [req.user.orgId];

      if (!canOrg && !canOversee) {
        conditions.push('b.sender_id = ?');
        params.push(req.user.id);
      }

      const [rows] = await pool.query(
        `SELECT b.*, u.name AS sender_name
           FROM broadcasts b
           JOIN users u ON u.id = b.sender_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY b.created_at DESC, b.id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      // A manager sees sender, subject and reach -- never the message body,
      // and never a recipient identity.
      //
      // Dropped from the serialized object rather than omitted from the SELECT
      // so there is exactly one place where "what a manager may see" is
      // decided. `manager` is in CAN_READ_BROADCAST_OVERSIGHT but not in
      // CAN_BROADCAST_ORG, so this branch cannot catch an owner.
      //
      // recipient_count is read straight off the row -- migration 0027's
      // reason for storing it is that satisfying this view must never require
      // a query against the recipient set.
      const oversightOnly = canOversee && !canOrg;
      const broadcasts = rows.map((row) => {
        const serialized = serializeBroadcast(row);
        if (oversightOnly) {
          delete serialized.body;
        }
        return serialized;
      });

      res.status(200).json({ broadcasts, limit, offset });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
