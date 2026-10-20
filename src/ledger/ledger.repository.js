// SQL only. No business rules here.
// Convention: the last argument is the database handle (default: the pool).
// Pass the transaction `client` for anything that must commit or roll back together.
const { pool } = require('../config/database');

const ACCOUNT_COLUMNS = 'id, account_type, user_id, event_id, balance';

// ---------------------------------------------------------------- accounts

async function insertAccount({ id, accountType, userId = null, eventId = null }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO accounts (id, account_type, user_id, event_id)
     VALUES ($1, $2, $3, $4)
     RETURNING ${ACCOUNT_COLUMNS}`,
    [id, accountType, userId, eventId]
  );
  return rows[0];
}

async function findAccountByUserId(userId, db = pool) {
  const { rows } = await db.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

async function findAccountByEventId(eventId, db = pool) {
  const { rows } = await db.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE event_id = $1`, [eventId]);
  return rows[0] || null;
}

async function findFundAccount(db = pool) {
  const { rows } = await db.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE account_type = 'MODERATOR_FUND'`
  );
  return rows[0] || null;
}

// Locks the rows in ascending id order, which is what prevents two transfers that touch
// the same pair of accounts from deadlocking each other.
async function lockAccounts(ids, db = pool) {
  const { rows } = await db.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids]
  );
  return rows;
}

async function lockFundAccount(db = pool) {
  const { rows } = await db.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE account_type = 'MODERATOR_FUND' FOR UPDATE`
  );
  return rows[0] || null;
}

// The ONLY statement in the whole backend that changes accounts.balance.
// A relative change (not "set to X") so a lost update is impossible even without the lock.
async function adjustBalance(accountId, delta, db = pool) {
  const { rows } = await db.query(
    'UPDATE accounts SET balance = balance + $2 WHERE id = $1 RETURNING balance',
    [accountId, delta]
  );
  return rows[0].balance;
}

// --------------------------------------------------------------- transfers

async function findTransferByReferenceKey(referenceKey, db = pool) {
  const { rows } = await db.query('SELECT * FROM ledger_transfers WHERE reference_key = $1', [referenceKey]);
  return rows[0] || null;
}

async function insertTransfer(t, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO ledger_transfers
       (id, reference_key, transfer_type, from_account_id, to_account_id, amount,
        from_balance_after, to_balance_after, description, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      t.id, t.referenceKey, t.transferType, t.fromAccountId, t.toAccountId, t.amount,
      t.fromBalanceAfter, t.toBalanceAfter, t.description, t.createdByUserId,
    ]
  );
  return rows[0];
}

// Newest first. The cursor is (created_at, id) of the last row already seen, with the
// timestamp kept as text so microseconds are not lost on the way through JavaScript.
async function listTransfersForAccount(accountId, { limit, cursorTime, cursorId }, db = pool) {
  const { rows } = await db.query(
    `SELECT lt.id, lt.transfer_type, lt.from_account_id, lt.to_account_id, lt.amount,
            lt.from_balance_after, lt.to_balance_after, lt.description,
            lt.created_by_user_id, lt.created_at,
            to_char(lt.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
       FROM ledger_transfers lt
      WHERE (lt.from_account_id = $1 OR lt.to_account_id = $1)
        AND ($2::timestamptz IS NULL OR (lt.created_at, lt.id) < ($2::timestamptz, $3::uuid))
      ORDER BY lt.created_at DESC, lt.id DESC
      LIMIT $4`,
    [accountId, cursorTime, cursorId, limit]
  );
  return rows;
}

// -------------------------------------------------------------- fund_topups

const TOPUP_SELECT = `
  SELECT ft.id, ft.ledger_transfer_id, ft.trigger_type, ft.event_id, ft.bet_id, ft.status,
         ft.authorized_by_user_id, ft.reviewed_by_user_id, ft.reviewed_at, ft.created_at,
         lt.amount, lt.description
    FROM fund_topups ft
    JOIN ledger_transfers lt ON lt.id = ft.ledger_transfer_id`;

async function insertFundTopup(t, db = pool) {
  await db.query(
    `INSERT INTO fund_topups
       (id, ledger_transfer_id, trigger_type, event_id, bet_id, status,
        authorized_by_user_id, reviewed_by_user_id, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END)`,
    [
      t.id, t.ledgerTransferId, t.triggerType, t.eventId, t.betId, t.status,
      t.authorizedByUserId, t.reviewedByUserId,
    ]
  );
}

async function findTopupById(id, { lock = false } = {}, db = pool) {
  const sql = `${TOPUP_SELECT} WHERE ft.id = $1${lock ? ' FOR UPDATE OF ft' : ''}`;
  const { rows } = await db.query(sql, [id]);
  return rows[0] || null;
}

async function findTopupByTransferId(ledgerTransferId, db = pool) {
  const { rows } = await db.query(`${TOPUP_SELECT} WHERE ft.ledger_transfer_id = $1`, [ledgerTransferId]);
  return rows[0] || null;
}

async function listTopups({ status, limit }, db = pool) {
  const { rows } = await db.query(
    `${TOPUP_SELECT}
      WHERE ($1::text IS NULL OR ft.status = $1)
      ORDER BY ft.created_at DESC, ft.id DESC
      LIMIT $2`,
    [status, limit]
  );
  return rows;
}

// Only moves a top-up out of PENDING_REVIEW. Returns how many rows changed (0 or 1).
async function markTopupReviewed(id, status, reviewerUserId, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE fund_topups
        SET status = $2, reviewed_by_user_id = $3, reviewed_at = now()
      WHERE id = $1 AND status = 'PENDING_REVIEW'`,
    [id, status, reviewerUserId]
  );
  return rowCount;
}

module.exports = {
  insertAccount,
  findAccountByUserId,
  findAccountByEventId,
  findFundAccount,
  lockAccounts,
  lockFundAccount,
  adjustBalance,
  findTransferByReferenceKey,
  insertTransfer,
  listTransfersForAccount,
  insertFundTopup,
  findTopupById,
  findTopupByTransferId,
  listTopups,
  markTopupReviewed,
};