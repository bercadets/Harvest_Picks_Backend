const { pool } = require('../../config/database');
const logger = require('./logger');

// Postgres error codes worth retrying: serialization failure and deadlock.
const RETRYABLE_CODES = new Set(['40001', '40P01']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work(client)` inside one database transaction.
 *  - COMMIT if it resolves, ROLLBACK if it throws (the error is re-thrown).
 *  - The client is always released.
 *  - Deadlocks / serialization failures are retried a couple of times.
 *  - A lock_timeout stops a request from waiting forever on a locked row.
 *
 * Pass the same `client` into every repository and *.api.js call that must
 * commit or roll back together. Keep `work` free of side effects outside the
 * database (emails, HTTP calls), because it can run more than once on retry.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query('SELECT ... FOR UPDATE', [id]);
 *     ...
 *     return something;
 *   });
 */
async function withTransaction(work, options = {}) {
  const { maxAttempts = 3, lockTimeoutMs = 5000 } = options;

  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let destroyClient = false;
    let retry = false;

    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = ${Number(lockTimeoutMs)}`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        destroyClient = true; // connection is in an unknown state: do not reuse it
        logger.error('ROLLBACK failed', { err: rollbackErr });
      }

      if (RETRYABLE_CODES.has(err.code) && attempt < maxAttempts) {
        retry = true;
        logger.warn('Retrying transaction', { code: err.code, attempt });
      } else {
        throw err;
      }
    } finally {
      client.release(destroyClient);
    }

    if (retry) await sleep(25 * attempt + Math.floor(Math.random() * 25));
  }
}

module.exports = { withTransaction };