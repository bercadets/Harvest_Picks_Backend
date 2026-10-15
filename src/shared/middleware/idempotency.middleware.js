const AppError = require('../utils/appError');

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Reads the Idempotency-Key header and exposes it as req.idempotencyKey.
 * The key is prefixed with the user's id, so two users can never collide
 * (or replay each other's requests) even if they send the same string.
 *
 * Mount it AFTER authenticate:
 *   router.post('/bets', authenticate, requireFarmer, idempotency(), controller.placeBet);
 *
 * The service stores req.idempotencyKey in the idempotency_key column. If an
 * insert hits the unique index, it loads and returns the original row instead.
 */
function idempotency({ required = true } = {}) {
  return (req, res, next) => {
    const header = req.get('Idempotency-Key');

    if (!header) {
      if (required) {
        return next(AppError.badRequest('The Idempotency-Key header is required for this request'));
      }
      req.idempotencyKey = null;
      return next();
    }

    if (!KEY_PATTERN.test(header)) {
      return next(
        AppError.badRequest(
          'Idempotency-Key must be 8-128 characters: letters, numbers, and . _ : -'
        )
      );
    }

    req.idempotencyKey = req.user ? `${req.user.id}:${header}` : header;
    next();
  };
}

module.exports = idempotency;