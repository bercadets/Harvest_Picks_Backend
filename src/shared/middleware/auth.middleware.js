const jwt = require('jsonwebtoken');
const { pool } = require('../../config/database');
const AppError = require('../utils/appError');

const ALGORITHM = 'HS256';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set in .env and be at least 32 characters long');
  }
  return secret;
}

// Called once at startup (server.js) so a bad config fails immediately.
function assertAuthConfig() {
  getSecret();
}

// Used by users.service on login. Keeping it here means the token format lives in one place.
function signToken(user) {
  return jwt.sign({ role: user.role, tv: user.token_version }, getSecret(), {
    algorithm: ALGORITHM,
    subject: user.id,
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
}

/**
 * Verifies the Bearer token, then checks the user is still ACTIVE and the
 * token_version matches (bumping token_version in the database logs a user out
 * everywhere). Sets req.user = { id, role } using the role stored in the database.
 *
 * NOTE: this is the one deliberate exception to "only a cohort's repository
 * touches its tables". Every protected route needs this check, and it is a
 * single read-only query on users.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.get('Authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw AppError.unauthorized('Missing or malformed Authorization header');
    }

    let payload;
    try {
      payload = jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] });
    } catch (err) {
      if (err.name === 'TokenExpiredError') throw AppError.unauthorized('Session expired');
      throw AppError.unauthorized('Invalid token');
    }

    const { rows } = await pool.query(
      'SELECT id, role, status, token_version FROM users WHERE id = $1',
      [payload.sub]
    );
    const user = rows[0];

    if (!user) throw AppError.unauthorized('Invalid token');
    if (user.status !== 'ACTIVE') throw AppError.forbidden('This account is not active');
    if (user.token_version !== payload.tv) {
      throw AppError.unauthorized('Session is no longer valid, please log in again');
    }

    req.user = { id: user.id, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

/** Use after authenticate: requireRole('MODERATOR') or requireRole('FARMER', 'MODERATOR'). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    next();
  };
}

module.exports = {
  authenticate,
  requireRole,
  requireFarmer: requireRole('FARMER'),
  requireModerator: requireRole('MODERATOR'),
  signToken,
  assertAuthConfig,
};