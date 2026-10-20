const { v7: uuidv7 } = require('uuid');

const AppError = require('../shared/utils/appError');
const { hashPassword, comparePassword } = require('../shared/utils/password');
const { withTransaction } = require('../shared/utils/transaction');
const { signToken } = require('../shared/middleware/auth.middleware');
const ledgerApi = require('../ledger/ledger.api');
const repo = require('./users.repository');

// Contract with the Ledger cohort. Registration needs this to exist in ledger.api.js:
//   openFarmerAccount({ userId }, client) -> inserts a FARMER account with balance 0
// If it is missing, registration fails and the whole transaction rolls back (no half-made user).

// Compared against when the name does not exist, so "unknown name" and "wrong password"
// take about the same time and cannot be told apart by timing.
let dummyHashPromise;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('harvest-picks-timing-guard');
  return dummyHashPromise;
}

function isNameTaken(err) {
  return err && err.code === '23505' && String(err.constraint || '').includes('name_normalized');
}

const toSessionUser = (row) => ({ id: row.id, name: row.name, role: row.role });

const toProfileDto = (row) => ({
  id: row.id,
  name: row.name,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  profile: {
    email: row.email,
    phoneNumber: row.phone_number,
    address: row.address,
  },
});

/** Public registration. Always creates a FARMER. Moderators are created by the seed script. */
async function register({ name, nameNormalized, password }) {
  // Hash first: it is slow CPU work and should not hold a database connection open.
  const passwordHash = await hashPassword(password);
  const userId = uuidv7();

  let user;
  try {
    user = await withTransaction(async (client) => {
      const created = await repo.insertUser(
        { id: userId, name, nameNormalized, passwordHash, role: 'FARMER' },
        client
      );
      await repo.insertEmptyProfile({ id: uuidv7(), userId }, client);
      await ledgerApi.openFarmerAccount({ userId }, client); // passbook starts at 0 points
      return created;
    });
  } catch (err) {
    if (isNameTaken(err)) throw AppError.conflict('That name is already taken');
    throw err;
  }

  return { user: toSessionUser(user), token: signToken(user) };
}

async function login({ nameNormalized, password }) {
  const user = await repo.findByNormalizedName(nameNormalized);
  const hash = user ? user.password_hash : await getDummyHash();
  const passwordOk = await comparePassword(password, hash);

  if (!user || !passwordOk) throw AppError.unauthorized('Invalid name or password');
  if (user.status !== 'ACTIVE') throw AppError.forbidden('This account is not active');

  await repo.touchLastLogin(user.id);
  return { user: toSessionUser(user), token: signToken(user) };
}

async function getMe(userId) {
  const row = await repo.findProfileById(userId);
  if (!row) throw AppError.notFound('User not found');
  return toProfileDto(row);
}

async function updateMe(userId, data) {
  try {
    await withTransaction(async (client) => {
      if (data.name !== undefined) {
        await repo.updateName(userId, data.name, data.nameNormalized, client);
      }
      await repo.upsertProfile(userId, uuidv7(), data.profile, client);
    });
  } catch (err) {
    if (isNameTaken(err)) throw AppError.conflict('That name is already taken');
    throw err;
  }
  return getMe(userId);
}

module.exports = { register, login, getMe, updateMe };