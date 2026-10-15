// Errors we throw on purpose. The error middleware turns these into clean JSON responses.
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message = 'Bad request', details) {
    return new AppError(message, 400, 'BAD_REQUEST', details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(message, 401, 'UNAUTHORIZED');
  }
  static forbidden(message = 'You are not allowed to do this') {
    return new AppError(message, 403, 'FORBIDDEN');
  }
  static notFound(message = 'Not found') {
    return new AppError(message, 404, 'NOT_FOUND');
  }
  static conflict(message = 'Conflict', details) {
    return new AppError(message, 409, 'CONFLICT', details);
  }
  static unprocessable(message = 'Unprocessable request', details) {
    return new AppError(message, 422, 'UNPROCESSABLE', details);
  }
}

module.exports = AppError;