import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function flatten(err: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    const bucket = out[key] ?? [];
    bucket.push(issue.message);
    out[key] = bucket;
  }
  return out;
}

/**
 * Validates and REPLACES the request payload with the parsed result, so
 * downstream code works with coerced, stripped, trusted data rather than raw
 * user input. This is also the first line of NoSQL-injection defence: an
 * object where a string was expected fails the schema.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query) as Record<string, unknown>;
        // Express 5 makes req.query a getter; assign properties instead.
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(
          AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Request validation failed', {
            fields: flatten(err),
          }),
        );
        return;
      }
      next(err);
    }
  };
}
