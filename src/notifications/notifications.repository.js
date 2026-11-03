// SQL only. No business rules here.
// Convention: the last argument is the database handle (default: the pool).
// Pass the transaction `client` when the notification must commit or roll back with the caller.
const { pool } = require('../config/database');

async function insertNotification(n, db = pool) {
  await db.query(
    `INSERT INTO notifications (id, user_id, type, message, reference_type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [n.id, n.userId, n.type, n.message, n.referenceType, n.referenceId]
  );
}

// Many rows in ONE statement (resolving an event notifies every bettor).
async function insertMany(list, db = pool) {
  await db.query(
    `INSERT INTO notifications (id, user_id, type, message, reference_type, reference_id)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::uuid[])`,
    [
      list.map((n) => n.id),
      list.map((n) => n.userId),
      list.map((n) => n.type),
      list.map((n) => n.message),
      list.map((n) => n.referenceType),
      list.map((n) => n.referenceId),
    ]
  );
}

// Newest first. The cursor is (created_at, id) of the last row already seen, with the time kept as
// text so microseconds survive the trip through JavaScript. Rows created in one transaction share
// the same created_at, so the id breaks the tie.
async function listForUser(userId, { unreadOnly, limit, cursorTime, cursorId }, db = pool) {
  const { rows } = await db.query(
    `SELECT id, type, message, reference_type, reference_id, is_read, created_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
       FROM notifications
      WHERE user_id = $1
        AND ($2::boolean = false OR is_read = false)
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $5`,
    [userId, unreadOnly, cursorTime, cursorId, limit]
  );
  return rows;
}

async function countUnread(userId, db = pool) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND is_read = false',
    [userId]
  );
  return rows[0].unread;
}

// Matches on BOTH id and owner, so someone else's notification looks exactly like a missing one.
// Marking an already-read notification is fine (it just stays read).
async function markRead(userId, id, db = pool) {
  const { rowCount } = await db.query(
    'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return rowCount === 1;
}

async function markAllRead(userId, db = pool) {
  const { rowCount } = await db.query(
    'UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false',
    [userId]
  );
  return rowCount;
}

module.exports = { insertNotification, insertMany, listForUser, countUnread, markRead, markAllRead };