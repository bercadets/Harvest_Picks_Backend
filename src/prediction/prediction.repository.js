// SQL only. No business rules here.
// Convention: the last argument is the database handle (default: the pool).
// Pass the transaction `client` for anything that must commit or roll back together.
const { pool } = require('../config/database');

// Time kept as text with microseconds so a keyset cursor survives the trip through JavaScript.
const cursorTime = (alias) =>
  `to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;

const EVENT_SELECT = `
  SELECT e.id, e.question, e.description, e.status, e.max_bet_points, e.house_margin, e.no_winner_policy,
         e.closes_at, e.winning_option_id, e.cancel_reason, e.created_by_user_id, e.resolved_by_user_id,
         e.resolved_at, e.cancelled_at, e.created_at, e.updated_at,
         (e.status = 'OPEN' AND clock_timestamp() < e.closes_at) AS betting_open,
         ${cursorTime('e')}
    FROM prediction_events e`;

const BET_SELECT = `
  SELECT b.id, b.event_id, b.option_id, b.farmer_user_id, b.stake_points, b.locked_multiplier,
         b.potential_payout_points, b.backing_points, b.status, b.settled_at, b.created_at,
         e.question, e.status AS event_status, o.label AS option_label,
         ${cursorTime('b')}
    FROM bets b
    JOIN prediction_events e ON e.id = b.event_id
    JOIN event_options o ON o.id = b.option_id`;

// ------------------------------------------------------------- idempotency

// Makes two requests with the same Idempotency-Key run one after the other, so the second one finds
// the first one's result instead of racing it. The lock is released when the transaction ends.
async function lockIdempotencyKey(key, db = pool) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

// ------------------------------------------------------------------ events

async function insertEvent(e, db = pool) {
  await db.query(
    `INSERT INTO prediction_events
       (id, question, description, max_bet_points, house_margin, no_winner_policy, closes_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.id, e.question, e.description, e.maxBetPoints, e.houseMargin, e.noWinnerPolicy, e.closesAt, e.createdByUserId]
  );
}

async function insertOptions(eventId, options, db = pool) {
  await db.query(
    `INSERT INTO event_options (id, event_id, label, seed_points, display_order)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::bigint[], $5::int[])`,
    [
      options.map((o) => o.id),
      options.map(() => eventId),
      options.map((o) => o.label),
      options.map((o) => o.seedPoints),
      options.map((o) => o.displayOrder),
    ]
  );
}

async function findEvent(id, db = pool) {
  const { rows } = await db.query(`${EVENT_SELECT} WHERE e.id = $1`, [id]);
  return rows[0] || null;
}

// Serializes everything that changes one event: bets, closing, resolving, cancelling.
// `past_close` uses real time (clock_timestamp), not the time the transaction started.
async function lockEvent(id, db = pool) {
  const { rows } = await db.query(
    `SELECT id, question, status, max_bet_points, house_margin, no_winner_policy, closes_at,
            created_by_user_id, winning_option_id, (clock_timestamp() >= closes_at) AS past_close
       FROM prediction_events WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

async function listEvents({ status, limit, cursorTime: time, cursorId }, db = pool) {
  const { rows } = await db.query(
    `${EVENT_SELECT}
      WHERE ($1::text IS NULL OR e.status = $1)
        AND ($2::timestamptz IS NULL OR (e.created_at, e.id) < ($2::timestamptz, $3::uuid))
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $4`,
    [status, time, cursorId, limit]
  );
  return rows;
}

// Every option with its seed and the real stakes on it. Refunded bets no longer count.
async function listOptionsWithPools(eventIds, db = pool) {
  const { rows } = await db.query(
    `SELECT o.id, o.event_id, o.label, o.seed_points, o.display_order,
            COALESCE(SUM(b.stake_points) FILTER (WHERE b.status <> 'REFUNDED'), 0)::bigint AS staked_points
       FROM event_options o
       LEFT JOIN bets b ON b.option_id = o.id
      WHERE o.event_id = ANY($1::uuid[])
      GROUP BY o.id
      ORDER BY o.event_id, o.display_order, o.id`,
    [eventIds]
  );
  return rows;
}

// Each only moves an event out of the status(es) it is allowed to leave. Returns rows changed (0 or 1).
async function markEventClosed(id, db = pool) {
  const { rowCount } = await db.query(
    "UPDATE prediction_events SET status = 'CLOSED' WHERE id = $1 AND status = 'OPEN'",
    [id]
  );
  return rowCount;
}

async function markEventResolved({ id, winningOptionId, resolvedByUserId }, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE prediction_events
        SET status = 'RESOLVED', winning_option_id = $2, resolved_by_user_id = $3, resolved_at = clock_timestamp()
      WHERE id = $1 AND status = 'CLOSED'`,
    [id, winningOptionId, resolvedByUserId]
  );
  return rowCount;
}

async function markEventCancelled({ id, reason }, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE prediction_events
        SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = clock_timestamp()
      WHERE id = $1 AND status IN ('OPEN', 'CLOSED')`,
    [id, reason]
  );
  return rowCount;
}

// -------------------------------------------------------------------- bets

async function insertBet(b, db = pool) {
  await db.query(
    `INSERT INTO bets
       (id, event_id, option_id, farmer_user_id, stake_points, locked_multiplier, potential_payout_points,
        backing_points, idempotency_key, stake_transfer_id, backing_transfer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      b.id, b.eventId, b.optionId, b.farmerUserId, b.stakePoints, b.lockedMultiplier, b.potentialPayoutPoints,
      b.backingPoints, b.idempotencyKey, b.stakeTransferId, b.backingTransferId,
    ]
  );
}

async function findBetById(id, db = pool) {
  const { rows } = await db.query(`${BET_SELECT} WHERE b.id = $1`, [id]);
  return rows[0] || null;
}

async function findBetByIdempotencyKey(key, db = pool) {
  const { rows } = await db.query(`${BET_SELECT} WHERE b.idempotency_key = $1`, [key]);
  return rows[0] || null;
}

async function listBets({ farmerUserId, eventId, status, limit, cursorTime: time, cursorId }, db = pool) {
  const { rows } = await db.query(
    `${BET_SELECT}
      WHERE ($1::uuid IS NULL OR b.farmer_user_id = $1)
        AND ($2::uuid IS NULL OR b.event_id = $2)
        AND ($3::text IS NULL OR b.status = $3)
        AND ($4::timestamptz IS NULL OR (b.created_at, b.id) < ($4::timestamptz, $5::uuid))
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $6`,
    [farmerUserId, eventId, status, time, cursorId, limit]
  );
  return rows;
}

// All still-open bets of an event, locked, in creation order (ids are time-ordered UUIDs).
async function listActiveBetsForSettlement(eventId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, option_id, farmer_user_id, stake_points, potential_payout_points, backing_points
       FROM bets WHERE event_id = $1 AND status = 'ACTIVE' ORDER BY id FOR UPDATE`,
    [eventId]
  );
  return rows;
}

// One statement for the whole event. Returns how many bets changed: the caller checks it equals the input.
async function settleBets(updates, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE bets b
        SET status = v.status,
            settlement_transfer_id = v.settlement_transfer_id,
            fund_return_transfer_id = v.fund_return_transfer_id,
            settled_at = clock_timestamp()
       FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::uuid[])
            AS v(id, status, settlement_transfer_id, fund_return_transfer_id)
      WHERE b.id = v.id AND b.status = 'ACTIVE'`,
    [
      updates.map((u) => u.betId),
      updates.map((u) => u.status),
      updates.map((u) => u.settlementTransferId),
      updates.map((u) => u.fundReturnTransferId),
    ]
  );
  return rowCount;
}

module.exports = {
  lockIdempotencyKey,
  insertEvent, insertOptions, findEvent, lockEvent, listEvents, listOptionsWithPools,
  markEventClosed, markEventResolved, markEventCancelled,
  insertBet, findBetById, findBetByIdempotencyKey, listBets, listActiveBetsForSettlement, settleBets,
};