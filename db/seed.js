// Run with: npm run seed
// Creates or refreshes the configured moderator (and creates the MODERATOR_FUND account
// if missing). A name already owned by a non-moderator is rejected rather than promoted.
// Set SEED_MODERATOR_NAME and SEED_MODERATOR_PASSWORD in .env, run it, then remove the password.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { v7: uuidv7 } = require('uuid');
const { pool } = require('../src/config/database');
const { hashPassword } = require('../src/shared/utils/password');

async function main() {
  // Same cleaning as the login validator: composed letters, trimmed, single spaces.
  const name = (process.env.SEED_MODERATOR_NAME || '').normalize('NFC').trim().replace(/\s+/g, ' ');
  const password = process.env.SEED_MODERATOR_PASSWORD || '';

  if (!name || password.length < 8) {
    console.error(
      'Set SEED_MODERATOR_NAME and SEED_MODERATOR_PASSWORD (at least 8 characters) in .env first.'
    );
    process.exit(1);
  }

  const nameNormalized = name.toLowerCase();
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const fund = await client.query(
      "SELECT id FROM accounts WHERE account_type = 'MODERATOR_FUND'"
    );
    if (fund.rowCount === 0) {
      await client.query(
        "INSERT INTO accounts (id, account_type) VALUES ($1, 'MODERATOR_FUND')",
        [uuidv7()]
      );
      console.log('Created the MODERATOR_FUND account.');
    } else {
      console.log('MODERATOR_FUND account already exists.');
    }

    const existing = await client.query(
      'SELECT id, role FROM users WHERE name_normalized = $1',
      [nameNormalized]
    );
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO users (id, name, name_normalized, password_hash, role)
         VALUES ($1, $2, $3, $4, 'MODERATOR')`,
        [uuidv7(), name, nameNormalized, passwordHash]
      );
      console.log(`Created moderator "${name}".`);
    } else if (existing.rows[0].role === 'MODERATOR') {
      await client.query(
        'UPDATE users SET name = $2, password_hash = $3 WHERE id = $1',
        [existing.rows[0].id, name, passwordHash]
      );
      console.log(`Updated moderator "${name}" credentials.`);
    } else {
      throw new Error(`A non-moderator user named "${name}" already exists; refusing to change its role.`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();