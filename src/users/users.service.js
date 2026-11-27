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

// ---- Login lockout policy ----
// Tune these numbers freely. After the last step, the longest lock repeats.
const LOCKOUT_POLICY = {
  FARMER: { maxAttempts: 5, lockSeconds: [60, 300, 900, 3600, 86400] },
  MODERATOR: { maxAttempts: 3, lockSeconds: [300, 900, 3600, 14400] },
};
const FAILURE_WINDOW_SECONDS = 15 * 60; // failures older than this stop counting
const LEVEL_RESET_SECONDS = 24 * 60 * 60; // lock levels cool down after a quiet day

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

function lockedError(seconds) {
  return new AppError('Too many failed login attempts. Try again later.', 429, 'ACCOUNT_LOCKED', {
    retryAfterSeconds: seconds,
  });
}

// Refuse before checking the password, so a correct password cannot bypass a lock.
async function assertNotLocked(userId) {
  const remaining = await repo.getLockRemainingSeconds(userId);
  if (remaining > 0) throw lockedError(remaining);
}

// Call after a wrong password. Throws ACCOUNT_LOCKED if this failure triggers a lock.
async function registerFailure(user) {
  const policy = LOCKOUT_POLICY[user.role] || LOCKOUT_POLICY.FARMER;

  const lockSeconds = await withTransaction(async (client) => {
    const row = await repo.lockUserRowForLogin(user.id, client);
    if (!row || row.is_locked) return 0; // a parallel request already locked it

    const since = row.secs_since_failure === null ? null : Number(row.secs_since_failure);
    let count = row.failed_login_count;
    let level = row.lockout_level;
    if (since !== null && since > FAILURE_WINDOW_SECONDS) count = 0;
    if (since !== null && since > LEVEL_RESET_SECONDS) level = 0;

    count += 1;
    let seconds = 0;
    if (count >= policy.maxAttempts) {
      seconds = policy.lockSeconds[Math.min(level, policy.lockSeconds.length - 1)];
      level += 1;
      count = 0;
    }

    await repo.saveLoginFailure(
      { userId: user.id, failedCount: count, lockoutLevel: level, lockSeconds: seconds },
      client
    );
    return seconds;
  });

  // Thrown after the transaction commits, so the failure is saved even though we return an error.
  if (lockSeconds > 0) throw lockedError(lockSeconds);
}

const registerSuccess = (userId) => repo.clearLoginFailures(userId);

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

  // Unknown name: same work and same generic error as before (nothing to lock).
  if (!user) {
    await comparePassword(password, await getDummyHash());
    throw AppError.unauthorized('Invalid name or password');
  }

  // A locked account is refused even if the password is correct.
  await assertNotLocked(user.id);

  const passwordOk = await comparePassword(password, user.password_hash);
  if (!passwordOk) {
    await registerFailure(user); // throws 429 when this failure triggers a lock
    throw AppError.unauthorized('Invalid name or password');
  }

  if (user.status !== 'ACTIVE') throw AppError.forbidden('This account is not active');

  await registerSuccess(user.id);
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