// Run with: npm run seed
// Creates the first moderator (and the MODERATOR_FUND account if it is somehow missing).
// Safe to run more than once. Set SEED_MODERATOR_NAME and SEED_MODERATOR_PASSWORD in .env,
// run it, then delete the password from .env.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { v7: uuidv7 } = require('uuid');
const { pool } = require('../src/config/database');

async function main() {
  const name = (process.env.SEED_MODERATOR_NAME || '').trim();
  const password = process.env.SEED_MODERATOR_PASSWORD || '';

  if (!name || password.length < 8) {
    console.error(
      'Set SEED_MODERATOR_NAME and SEED_MODERATOR_PASSWORD (at least 8 characters) in .env first.'
    );
    process.exit(1);
  }

  const nameNormalized = name.toLowerCase(); // already trimmed
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
      'SELECT id FROM users WHERE name_normalized = $1',
      [nameNormalized]
    );
    if (existing.rowCount === 0) {
      const passwordHash = await bcrypt.hash(password, 12);
      await client.query(
        `INSERT INTO users (id, name, name_normalized, password_hash, role)
         VALUES ($1, $2, $3, $4, 'MODERATOR')`,
        [uuidv7(), name, nameNormalized, passwordHash]
      );
      console.log(`Created moderator "${name}".`);
    } else {
      console.log(`A user named "${name}" already exists. Nothing changed.`);
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