// SQL only. No business rules here.
// Convention: the last argument is the database handle (default: the pool).
// Pass the transaction `client` for anything that must commit or roll back together.
const { pool } = require('../config/database');

// Time kept as text with microseconds so a keyset cursor survives the trip through JavaScript.
const CURSOR_TIME = `to_char(%A%.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;

const DEPOSIT_SELECT = `
  SELECT d.id, d.farmer_user_id, d.crop_id, d.crop_rate_id, d.quantity, d.rate_points_per_unit,
         d.estimated_points, d.status, d.rejection_reason, d.reviewed_by_user_id, d.reviewed_at,
         d.ledger_transfer_id, d.created_at, ${CURSOR_TIME.replace('%A%', 'd')}
    FROM crop_deposits d`;

const ORDER_SELECT = `
  SELECT o.id, o.farmer_user_id, o.total_points, o.status, o.delivery_token_hash, o.ledger_transfer_id,
         o.delivered_by_user_id, o.delivered_at, o.created_at, ${CURSOR_TIME.replace('%A%', 'o')}
    FROM orders o`;

// ------------------------------------------------------------- idempotency

// Makes two requests with the same Idempotency-Key run one after the other, so the second one finds
// the first one's result instead of racing it. The lock is released when the transaction ends.
async function lockIdempotencyKey(key, db = pool) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

// ---------------------------------------------------------------- deposits

async function insertDeposit(d, db = pool) {
  await db.query(
    `INSERT INTO crop_deposits
       (id, farmer_user_id, crop_id, crop_rate_id, quantity, rate_points_per_unit, estimated_points, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [d.id, d.farmerUserId, d.cropId, d.cropRateId, d.quantity, d.ratePointsPerUnit, d.estimatedPoints, d.idempotencyKey]
  );
}

async function findDepositById(id, { lock = false } = {}, db = pool) {
  const { rows } = await db.query(`${DEPOSIT_SELECT} WHERE d.id = $1${lock ? ' FOR UPDATE OF d' : ''}`, [id]);
  return rows[0] || null;
}

async function findDepositByIdempotencyKey(key, db = pool) {
  const { rows } = await db.query(`${DEPOSIT_SELECT} WHERE d.idempotency_key = $1`, [key]);
  return rows[0] || null;
}

// farmerUserId / status may be null = no filter. `ascending` is the moderator's queue order (oldest first).
async function listDeposits({ farmerUserId, status, ascending, limit, cursorTime, cursorId }, db = pool) {
  const op = ascending ? '>' : '<';
  const dir = ascending ? 'ASC' : 'DESC';
  const { rows } = await db.query(
    `${DEPOSIT_SELECT}
      WHERE ($1::uuid IS NULL OR d.farmer_user_id = $1)
        AND ($2::text IS NULL OR d.status = $2)
        AND ($3::timestamptz IS NULL OR (d.created_at, d.id) ${op} ($3::timestamptz, $4::uuid))
      ORDER BY d.created_at ${dir}, d.id ${dir}
      LIMIT $5`,
    [farmerUserId, status, cursorTime, cursorId, limit]
  );
  return rows;
}

// Both only move a deposit out of PENDING and return how many rows changed (0 or 1).
async function markDepositApproved({ id, reviewerUserId, ledgerTransferId }, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE crop_deposits
        SET status = 'APPROVED', reviewed_by_user_id = $2, reviewed_at = clock_timestamp(), ledger_transfer_id = $3
      WHERE id = $1 AND status = 'PENDING'`,
    [id, reviewerUserId, ledgerTransferId]
  );
  return rowCount;
}

async function markDepositRejected({ id, reviewerUserId, reason }, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE crop_deposits
        SET status = 'REJECTED', reviewed_by_user_id = $2, reviewed_at = clock_timestamp(), rejection_reason = $3
      WHERE id = $1 AND status = 'PENDING'`,
    [id, reviewerUserId, reason]
  );
  return rowCount;
}

// ------------------------------------------------------------------ orders

async function insertOrder(o, db = pool) {
  await db.query(
    `INSERT INTO orders (id, farmer_user_id, total_points, delivery_token_hash, ledger_transfer_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [o.id, o.farmerUserId, o.totalPoints, o.deliveryTokenHash, o.ledgerTransferId, o.idempotencyKey]
  );
}

async function insertOrderItems(orderId, lines, db = pool) {
  await db.query(
    `INSERT INTO order_items (id, order_id, shop_item_id, quantity, unit_price_points, line_total_points)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::int[], $5::bigint[], $6::bigint[])`,
    [
      lines.map((l) => l.id),
      lines.map(() => orderId),
      lines.map((l) => l.itemId),
      lines.map((l) => l.quantity),
      lines.map((l) => l.unitPricePoints),
      lines.map((l) => l.lineTotalPoints),
    ]
  );
}

async function findOrderItems(orderIds, db = pool) {
  const { rows } = await db.query(
    `SELECT order_id, shop_item_id, quantity, unit_price_points, line_total_points
       FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY order_id, id`,
    [orderIds]
  );
  return rows;
}

async function findOrderById(id, { lock = false } = {}, db = pool) {
  const { rows } = await db.query(`${ORDER_SELECT} WHERE o.id = $1${lock ? ' FOR UPDATE OF o' : ''}`, [id]);
  return rows[0] || null;
}

async function findOrderByIdempotencyKey(key, db = pool) {
  const { rows } = await db.query(`${ORDER_SELECT} WHERE o.idempotency_key = $1`, [key]);
  return rows[0] || null;
}

async function findOrderByTokenHash(hash, db = pool) {
  const { rows } = await db.query(`${ORDER_SELECT} WHERE o.delivery_token_hash = $1`, [hash]);
  return rows[0] || null;
}

async function listOrders({ farmerUserId, status, ascending, limit, cursorTime, cursorId }, db = pool) {
  const op = ascending ? '>' : '<';
  const dir = ascending ? 'ASC' : 'DESC';
  const { rows } = await db.query(
    `${ORDER_SELECT}
      WHERE ($1::uuid IS NULL OR o.farmer_user_id = $1)
        AND ($2::text IS NULL OR o.status = $2)
        AND ($3::timestamptz IS NULL OR (o.created_at, o.id) ${op} ($3::timestamptz, $4::uuid))
      ORDER BY o.created_at ${dir}, o.id ${dir}
      LIMIT $5`,
    [farmerUserId, status, cursorTime, cursorId, limit]
  );
  return rows;
}

async function markOrderDelivered({ id, moderatorUserId }, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE orders
        SET status = 'DELIVERED', delivered_by_user_id = $2, delivered_at = clock_timestamp()
      WHERE id = $1 AND status = 'PENDING_DELIVERY'`,
    [id, moderatorUserId]
  );
  return rowCount;
}

module.exports = {
  lockIdempotencyKey,
  insertDeposit, findDepositById, findDepositByIdempotencyKey, listDeposits, markDepositApproved, markDepositRejected,
  insertOrder, insertOrderItems, findOrderItems, findOrderById, findOrderByIdempotencyKey, findOrderByTokenHash,
  listOrders, markOrderDelivered,
};