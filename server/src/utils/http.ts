import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ApiSuccess, Paginated } from '../types';

/** Wraps async handlers so rejected promises reach the error middleware. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function ok<T>(res: Response, data: T, message?: string): Response<ApiSuccess<T>> {
  return res.status(200).json({ success: true, data, ...(message ? { message } : {}) });
}

export function created<T>(res: Response, data: T, message?: string): Response<ApiSuccess<T>> {
  return res.status(201).json({ success: true, data, ...(message ? { message } : {}) });
}

export function paginate<T>(items: T[], page: number, limit: number, total: number): Paginated<T> {
  return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/** Best-effort client IP, honouring a trusted proxy hop. */
export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0];
    if (first) return first.trim();
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
