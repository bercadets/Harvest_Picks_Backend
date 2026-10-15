require('dotenv').config();
const { Pool, types } = require('pg');
const logger = require('../shared/utils/logger');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

// bigint (OID 20): all point amounts are bigint. pg returns them as strings by default.
// Points in this simulation are far below 2^53, so convert to numbers and refuse anything unsafe.
types.setTypeParser(20, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`bigint value ${value} is outside the safe integer range`);
  }
  return n;
});
// numeric (OID 1700) is deliberately left as a STRING (rates, multipliers, margins).
// Do decimal math on those with integers or a decimal library, never floating point.

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on an idle database client', { err });
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};