import type { AuthUser } from './index';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
      /**
       * The exact bytes of the request body, captured before parsing.
       *
       * A party's HMAC signature covers what they actually sent, so the check
       * has to see the same bytes. Re-serialising the parsed object would not
       * do: key order, whitespace and number formatting are all free to differ,
       * and any of those differences breaks the signature for no reason.
       */
      rawBody?: string;
      /** Set by the API-key middleware once a signed request is verified. */
      apiCaller?: { keyId: string; partyId: string; callbackUrl: string | null };
    }
  }
}

export {};
