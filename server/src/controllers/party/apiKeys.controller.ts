import type { Request, Response } from 'express';
import { asyncHandler, ok, created } from '../../utils/http';
import { issueApiKey, listApiKeys, revokeApiKey } from '../../services/apiKey.service';
import { partyContext } from './context';
/**
 * Issue a key for the party's own server.
 *
 * The secret comes back exactly once. It is never shown again and cannot be
 * looked up — not because we could not decrypt it, but because a credential
 * that can be re-read from a dashboard is a credential that leaks the first
 * time somebody shares their screen. A lost secret is replaced, not recovered.
 */
export const createApiKey = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const { label, callbackUrl } = req.body as { label: string; callbackUrl?: string };

  const issued = await issueApiKey(partyId, label, actor, callbackUrl);

  return created(
    res,
    {
      keyId: issued.keyId,
      secret: issued.secret,
      label: issued.record.label,
      callbackUrl: issued.record.callbackUrl ?? null,
      createdAt: issued.record.createdAt.toISOString(),
    },
    'Save this secret now — it cannot be shown again',
  );
});

export const listApiKeysForParty = asyncHandler(async (req: Request, res: Response) => {
  const { partyId } = partyContext(req);
  const keys = await listApiKeys(partyId);

  return ok(
    res,
    keys.map((k) => ({
      keyId: k.keyId,
      label: k.label,
      status: k.status,
      callbackUrl: k.callbackUrl ?? null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
    })),
  );
});

export const revokeApiKeyForParty = asyncHandler(async (req: Request, res: Response) => {
  const { partyId, actor } = partyContext(req);
  const keyId = req.params['keyId'] as string;

  const revoked = await revokeApiKey(keyId, partyId, actor);
  return ok(res, { keyId: revoked.keyId, status: revoked.status }, 'Key revoked');
});
