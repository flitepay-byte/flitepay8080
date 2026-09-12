import { ErrorCodes, type ErrorCode } from './errorCodes';

/**
 * Operational error carrying an HTTP status and a stable error code.
 * Anything that is NOT an AppError is treated as a programmer error and
 * surfaced to the client as a generic INTERNAL_ERROR (never a stack trace).
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly details: Record<string, unknown>;
  public readonly isOperational = true;

  constructor(
    statusCode: number,
    errorCode: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    Error.captureStackTrace(this, AppError);
  }

  static badRequest(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(400, code, message, details);
  }
  static unauthorized(message = 'Authentication required', code: ErrorCode = ErrorCodes.UNAUTHENTICATED): AppError {
    return new AppError(401, code, message);
  }
  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError(403, ErrorCodes.FORBIDDEN, message);
  }
  static notFound(message = 'Resource not found', code: ErrorCode = ErrorCodes.NOT_FOUND): AppError {
    return new AppError(404, code, message);
  }
  static conflict(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(409, code, message, details);
  }
  static unprocessable(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(422, code, message, details);
  }
  static tooManyRequests(message = 'Too many requests', details?: Record<string, unknown>): AppError {
    return new AppError(429, ErrorCodes.RATE_LIMITED, message, details);
  }
  static internal(message = 'An unexpected error occurred'): AppError {
    return new AppError(500, ErrorCodes.INTERNAL_ERROR, message);
  }
}
