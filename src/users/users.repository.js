// SQL only. No business rules here.
// Convention for every repository: the last argument is the database handle. Leave it out
// for a plain read (uses the pool) or pass the transaction `client` for writes that must
// commit or roll back together.
const { pool } = require('../config/database');

// API field name -> column name. Only these can ever reach the SQL text.
const PROFILE_COLUMNS = {
  email: 'email',
  phoneNumber: 'phone_number',
  address: 'address',
};

async function findByNormalizedName(nameNormalized, db = pool) {
  const { rows } = await db.query(
    `SELECT id, name, name_normalized, password_hash, role, status, token_version
       FROM users
      WHERE name_normalized = $1`,
    [nameNormalized]
  );
  return rows[0] || null;
}

async function findProfileById(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.role, u.status, u.created_at, u.last_login_at,
            p.email, p.phone_number, p.address
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function insertUser({ id, name, nameNormalized, passwordHash, role }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO users (id, name, name_normalized, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, role, status, token_version`,
    [id, name, nameNormalized, passwordHash, role]
  );
  return rows[0];
}

async function insertEmptyProfile({ id, userId }, db = pool) {
  await db.query('INSERT INTO user_profiles (id, user_id) VALUES ($1, $2)', [id, userId]);
}

async function updateName(userId, name, nameNormalized, db = pool) {
  await db.query('UPDATE users SET name = $2, name_normalized = $3 WHERE id = $1', [
    userId,
    name,
    nameNormalized,
  ]);
}

// Creates the profile row if it does not exist yet (moderators are seeded without one),
// and changes only the fields that were provided.
async function upsertProfile(userId, profileId, fields, db = pool) {
  const keys = Object.keys(fields).filter((key) => key in PROFILE_COLUMNS);
  if (keys.length === 0) return;

  const columns = keys.map((key) => PROFILE_COLUMNS[key]);
  const values = keys.map((key) => fields[key]);
  const placeholders = columns.map((_, i) => `$${i + 3}`);
  const updates = columns.map((column) => `${column} = EXCLUDED.${column}`);

  await db.query(
    `INSERT INTO user_profiles (id, user_id, ${columns.join(', ')})
     VALUES ($1, $2, ${placeholders.join(', ')})
     ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}`,
    [profileId, userId, ...values]
  );
}

async function touchLastLogin(userId, db = pool) {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

module.exports = {
  findByNormalizedName,
  findProfileById,
  insertUser,
  insertEmptyProfile,
  updateName,
  upsertProfile,
  touchLastLogin,
};