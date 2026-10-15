const AppError = require('../utils/appError');
const logger = require('../utils/logger');

// Postgres error codes we translate into safe, generic messages.
// The real database message is logged, never sent to the client.
const PG_ERRORS = {
  '23505': [409, 'CONFLICT', 'This record already exists'],
  '23503': [409, 'CONFLICT', 'A related record was not found or is still in use'],
  '23514': [422, 'UNPROCESSABLE', 'The request breaks a data rule'],
  '23502': [400, 'BAD_REQUEST', 'A required value is missing'],
  '22P02': [400, 'BAD_REQUEST', 'A value has an invalid format'],
  '40P01': [503, 'RETRY_LATER', 'The system is busy, please try again'],
  '40001': [503, 'RETRY_LATER', 'The system is busy, please try again'],
  '55P03': [503, 'RETRY_LATER', 'The system is busy, please try again'],
};

function notFoundHandler(req, res, next) {
  next(AppError.notFound('Route not found'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details;

  if (err instanceof AppError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err && err.name === 'ZodError') {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Invalid request data';
    details = (err.issues || []).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_REQUEST';
    message = 'Request body is not valid JSON';
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  } else if (err && typeof err.code === 'string' && PG_ERRORS[err.code]) {
    [status, code, message] = PG_ERRORS[err.code];
  }

  if (status >= 500) {
    logger.error('Request failed', { err, method: req.method, path: req.path });
  } else {
    logger.debug('Request rejected', { status, code, method: req.method, path: req.path });
  }

  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };