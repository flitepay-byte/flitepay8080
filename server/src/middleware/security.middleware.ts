import helmet from 'helmet';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { randomToken } from '../utils/ids';

/** The configured origins, one per entry. Shared so CSP and CORS cannot disagree. */
function allowedOrigins(): string[] {
  return env.CLIENT_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Swagger UI needs inline styles.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        // Split, exactly as corsPolicy() below does. CLIENT_ORIGIN is a
        // comma-separated list, and a CSP directive value containing a comma
        // is invalid — helmet rejects it while building the middleware, so
        // configuring a second allowed origin stopped the API from starting
        // at all rather than from allowing the origin.
        connectSrc: ["'self'", ...allowedOrigins()],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

export function corsPolicy(): RequestHandler {
  const allowed = new Set(allowedOrigins());
  return cors({
    origin: (origin, callback) => {
      // Same-origin, curl, and server-to-server requests carry no Origin.
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      logger.warn({ origin }, 'Blocked by CORS policy');
      return callback(new Error('Not allowed by CORS'));
    },
    // Required for the HTTP-only auth cookies.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-csrf-token'],
    maxAge: 600,
  });
}

/**
 * Strips `$`-prefixed and dotted keys from user input, which is how NoSQL
 * operator injection (e.g. `{"email": {"$ne": null}}`) reaches a query.
 */
export function noSqlInjectionGuard(): RequestHandler {
  return mongoSanitize({
    replaceWith: '_',
    onSanitize: ({ key }) => {
      logger.warn({ key }, 'Stripped a potential NoSQL operator from request input');
    },
  });
}

/** Correlation id echoed on every response, for log tracing. */
export function requestId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming.length <= 64 ? incoming : randomToken(8);
    req.requestId = id;
    res.setHeader('x-request-id', id);
    next();
  };
}
