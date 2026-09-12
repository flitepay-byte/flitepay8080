import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import routes from './routes';
import { LOCAL_UPLOAD_DIR, LOCAL_UPLOAD_ROUTE } from './services/storage.service';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import {
  securityHeaders,
  corsPolicy,
  noSqlInjectionGuard,
  requestId,
} from './middleware/security.middleware';
import { globalLimiter } from './middleware/rateLimit.middleware';
import { csrfProtection } from './middleware/csrf.middleware';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from './config/swagger';

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy in Compose; needed for correct client IPs.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId());
  app.use(securityHeaders());
  app.use(corsPolicy());
  app.use(
    pinoHttp({
      logger,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'debug';
      },
      customProps: (req) => ({ requestId: (req as express.Request).requestId }),
    }),
  );

  app.use(
    express.json({
      limit: '1mb',
      // Captured here rather than in a route: by the time a handler runs, the
      // original bytes are gone, and a signature can only be checked against
      // the bytes that were actually signed.
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(noSqlInjectionGuard());
  app.use(csrfProtection);
  app.use(globalLimiter);

  // Interactive API documentation.
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument as unknown as Record<string, unknown>, {
    customSiteTitle: 'OTDMS API (simulation)',
  }));
  app.get('/openapi.json', (_req, res) => res.json(openApiDocument));

  // Uploaded files, when Cloudinary is not configured and they went to local
  // disk instead. Served read-only and with no directory listing, so the only
  // way to reach a file is to already hold its opaque name.
  app.use(
    LOCAL_UPLOAD_ROUTE,
    express.static(LOCAL_UPLOAD_DIR, {
      index: false,
      dotfiles: 'ignore',
      // Uploads are immutable once written — the name is random and never
      // reused — so they can be cached hard.
      maxAge: '30d',
      // Falls through to the app's own not-found handler, so a missing file is
      // a plain 404 rather than an unhandled error reported as a 500.
      fallthrough: true,
    }),
  );

  app.use(env.API_PREFIX, routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
