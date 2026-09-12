import type { Request, Response, NextFunction } from 'express';
import { MongoServerError } from 'mongodb';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError } from '../utils/AppError';
import { ErrorCodes, type ErrorCode } from '../utils/errorCodes';
import { logger } from '../config/logger';
import { isProd } from '../config/env';
import type { ApiFailure } from '../types';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
}

interface NormalisedError {
  statusCode: number;
  errorCode: ErrorCode;
  message: string;
  details: Record<string, unknown>;
  logAsError: boolean;
}

/** Maps infrastructure exceptions onto the standard error envelope. */
function normalise(err: unknown): NormalisedError {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      errorCode: err.errorCode,
      message: err.message,
      details: err.details,
      logAsError: err.statusCode >= 500,
    };
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string> = {};
    for (const [path, issue] of Object.entries(err.errors)) {
      fields[path] = issue.message;
    }
    return {
      statusCode: 400,
      errorCode: ErrorCodes.VALIDATION_ERROR,
      message: 'The submitted data failed validation',
      details: { fields },
      logAsError: false,
    };
  }

  if (err instanceof mongoose.Error.CastError) {
    return {
      statusCode: 400,
      errorCode: ErrorCodes.VALIDATION_ERROR,
      message: `Invalid value for ${err.path}`,
      details: {},
      logAsError: false,
    };
  }

  if (err instanceof mongoose.Error.VersionError) {
    return {
      statusCode: 409,
      errorCode: ErrorCodes.CONFLICT,
      message: 'This record was modified by another operation. Reload and try again.',
      details: {},
      logAsError: false,
    };
  }

  if (err instanceof MongoServerError && err.code === 11000) {
    const key = Object.keys((err.keyPattern as Record<string, unknown>) ?? {})[0] ?? 'field';
    return {
      statusCode: 409,
      errorCode: ErrorCodes.CONFLICT,
      message: `A record with this ${key} already exists`,
      details: { field: key },
      logAsError: false,
    };
  }

  if (err instanceof multer.MulterError) {
    const isSize = err.code === 'LIMIT_FILE_SIZE';
    return {
      statusCode: 400,
      errorCode: isSize ? ErrorCodes.FILE_TOO_LARGE : ErrorCodes.VALIDATION_ERROR,
      message: isSize ? 'The uploaded file exceeds the maximum allowed size' : `Upload error: ${err.message}`,
      details: { field: err.field },
      logAsError: false,
    };
  }

  // body-parser rejects an oversized body correctly, but as a plain Error —
  // without this it fell through to the catch-all and answered a client
  // mistake with a 500, which both misleads the caller and buries real
  // server errors in the logs.
  if (
    typeof err === 'object' && err !== null &&
    (err as { type?: string }).type === 'entity.too.large'
  ) {
    return {
      statusCode: 413,
      errorCode: ErrorCodes.PAYLOAD_TOO_LARGE,
      message: 'The request body is too large',
      details: {},
      logAsError: false,
    };
  }

  return {
    statusCode: 500,
    errorCode: ErrorCodes.INTERNAL_ERROR,
    message: 'An unexpected error occurred',
    details: {},
    logAsError: true,
  };
}

/**
 * Centralised error handler. Stack traces are logged server-side and never
 * returned to the client.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const normalised = normalise(err);

  const logPayload = {
    err,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.userId,
    errorCode: normalised.errorCode,
  };
  if (normalised.logAsError) {
    logger.error(logPayload, 'Request failed');
  } else {
    logger.warn(logPayload, 'Request rejected');
  }

  const body: ApiFailure = {
    success: false,
    message: normalised.message,
    errorCode: normalised.errorCode,
    ...(Object.keys(normalised.details).length > 0 ? { details: normalised.details } : {}),
  };

  // Development convenience only; suppressed entirely in production.
  if (!isProd && normalised.logAsError && err instanceof Error) {
    body.details = { ...(body.details ?? {}), devMessage: err.message };
  }

  res.status(normalised.statusCode).json(body);
}
