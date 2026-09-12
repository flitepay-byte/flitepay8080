import type { Request, Response, NextFunction } from 'express';
import { verifySignedRequest } from '../services/apiKey.service';

export const API_KEY_HEADER = 'x-otdms-key';
export const API_TIMESTAMP_HEADER = 'x-otdms-timestamp';
export const API_SIGNATURE_HEADER = 'x-otdms-signature';

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Authenticate a party's server by the signature on its request.
 *
 * The signed path is `req.originalUrl` rather than `req.path`, because the
 * party signs the URL they actually called — mount points and route prefixes
 * are our business, not theirs, and a signature that covered only the tail of
 * the path would let a captured call be replayed against a different endpoint
 * on the same router.
 *
 * The body is the raw bytes captured at parse time, never a re-serialisation
 * of the parsed object: key order and formatting are free to differ, and any
 * difference breaks an otherwise valid signature.
 */
export function requireApiKey(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    try {
      const verified = await verifySignedRequest({
        keyId: header(req, API_KEY_HEADER),
        timestamp: header(req, API_TIMESTAMP_HEADER),
        signature: header(req, API_SIGNATURE_HEADER),
        method: req.method,
        path: req.originalUrl,
        // A GET has no body, and both ends must agree that this is the empty
        // string rather than "undefined" or "null".
        rawBody: req.rawBody ?? '',
      });

      req.apiCaller = {
        keyId: verified.key.keyId,
        partyId: String(verified.partyId),
        callbackUrl: verified.key.callbackUrl ?? null,
      };
      next();
    } catch (err) {
      next(err);
    }
  })();
}
