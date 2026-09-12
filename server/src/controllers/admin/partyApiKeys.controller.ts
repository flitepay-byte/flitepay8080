import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler, ok, created } from '../../utils/http';
import { adminActor } from './actor';
import { AppError } from '../../utils/AppError';
import { ErrorCodes } from '../../utils/errorCodes';
import { Party, ApiKey } from '../../models';
import { issueApiKey, revokeApiKey, listApiKeys } from '../../services/apiKey.service';
import {
  buildIntegrationPackage,
  renderIntegrationPdf,
} from '../../services/integrationPackage.service';
import { recordAudit } from '../../services/audit.service';

/**
 * A PARTY'S API ACCESS, MANAGED BY AN ADMINISTRATOR
 * -------------------------------------------------
 * The party can already do all of this from its own dashboard. This exists
 * because of the one moment when it cannot: onboarding. A party that has not
 * signed in yet has no way to issue its first credential, and the API is for
 * servers — it cannot bootstrap its own access.
 *
 * So this is the same service the party's own screen calls,
 * `apiKey.service.ts`, reached by an administrator instead. No second
 * authentication scheme, no separate key type, nothing about a key that records
 * which door it was created through.
 *
 * The secret appears in exactly one response: the one that creates the key. It
 * is never read back, never written to an audit row, and never reachable from
 * any other endpoint here.
 */

async function partyOr404(partyId: string) {
  const party = await Party.findById(partyId).select('partyCode companyName').lean();
  if (!party) throw AppError.notFound('Party not found', ErrorCodes.PARTY_NOT_FOUND);
  return party;
}

/** Where this deployment is reachable, for the document handed to the party. */
function baseUrlOf(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  return `${proto}://${req.get('host') ?? 'localhost'}`;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const partyId = req.params['partyId'] as string;
  await partyOr404(partyId);

  const keys = await listApiKeys(new Types.ObjectId(partyId));
  return ok(res, {
    // `toJSON` on the model strips the encrypted secret, so nothing sensitive
    // can reach this response even by accident.
    keys: keys.map((k) => ({
      keyId: k.keyId,
      label: k.label,
      status: k.status,
      callbackUrl: k.callbackUrl ?? null,
      lastUsedAt: k.lastUsedAt ?? null,
      revokedAt: k.revokedAt ?? null,
      createdAt: k.createdAt,
    })),
  });
});

/**
 * Create a key and hand back the whole integration package with it.
 *
 * The package is built here, in the same response, because this is the only
 * moment the secret exists outside the party's own server. Building it later
 * would produce a document with a hole in it.
 */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const partyId = req.params['partyId'] as string;
  const party = await partyOr404(partyId);
  const body = req.body as { label: string; callbackUrl?: string };

  const issued = await issueApiKey(
    new Types.ObjectId(partyId),
    body.label,
    actor,
    body.callbackUrl,
  );

  return created(
    res,
    {
      keyId: issued.keyId,
      secret: issued.secret,
      label: issued.record.label,
      status: issued.record.status,
      callbackUrl: issued.record.callbackUrl ?? null,
      createdAt: issued.record.createdAt,
      integration: buildIntegrationPackage({
        partyName: party.companyName,
        partyCode: party.partyCode,
        keyId: issued.keyId,
        secret: issued.secret,
        callbackUrl: issued.record.callbackUrl ?? null,
        baseUrl: baseUrlOf(req),
      }),
    },
    'Key created — copy the secret now, it cannot be shown again',
  );
});

export const revoke = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const partyId = req.params['partyId'] as string;
  await partyOr404(partyId);

  const key = await revokeApiKey(
    req.params['keyId'] as string,
    new Types.ObjectId(partyId),
    actor,
  );
  return ok(res, { keyId: key.keyId, status: key.status, revokedAt: key.revokedAt }, 'Key revoked');
});

/**
 * Change where a key's callbacks go.
 *
 * Editable after the fact because a party's endpoint moves — between a staging
 * host and a real one, or when they redeploy — and making them issue a fresh
 * credential for that would mean a pointless rotation each time.
 */
export const updateCallbackUrl = asyncHandler(async (req: Request, res: Response) => {
  const actor = adminActor(req);
  const partyId = req.params['partyId'] as string;
  await partyOr404(partyId);
  const { callbackUrl } = req.body as { callbackUrl: string | null };

  const key = await ApiKey.findOneAndUpdate(
    { keyId: req.params['keyId'] as string, partyId: new Types.ObjectId(partyId) },
    { $set: { callbackUrl: callbackUrl?.trim() || null } },
    { new: true },
  );
  if (!key) throw AppError.notFound('API key not found', ErrorCodes.NOT_FOUND);

  await recordAudit({
    action: 'API_KEY_ISSUED',
    targetCollection: 'ApiKey',
    targetId: key._id,
    userId: actor.userId,
    role: 'ADMIN',
    ip: actor.ip,
    newState: { keyId: key.keyId, callbackUrl: key.callbackUrl ?? null },
    metadata: { change: 'callbackUrl' },
  });

  return ok(res, { keyId: key.keyId, callbackUrl: key.callbackUrl ?? null }, 'Callback URL saved');
});

/**
 * The integration document for an existing key, without the secret.
 *
 * Useful when the party has lost the instructions but still holds the
 * credential. If they have lost the secret too, the answer is a new key — there
 * is nowhere to read the old one from.
 */
export const integrationDetails = asyncHandler(async (req: Request, res: Response) => {
  const partyId = req.params['partyId'] as string;
  const party = await partyOr404(partyId);

  const key = await ApiKey.findOne({
    keyId: req.params['keyId'] as string,
    partyId: new Types.ObjectId(partyId),
  }).lean();
  if (!key) throw AppError.notFound('API key not found', ErrorCodes.NOT_FOUND);

  return ok(
    res,
    buildIntegrationPackage({
      partyName: party.companyName,
      partyCode: party.partyCode,
      keyId: key.keyId,
      secret: null,
      callbackUrl: key.callbackUrl ?? null,
      baseUrl: baseUrlOf(req),
    }),
  );
});

/**
 * The same document as a PDF.
 *
 * The secret is accepted from the request rather than looked up, because it
 * cannot be looked up. The administrator has it on screen for one moment after
 * creating the key; if they download in that moment the PDF is complete, and if
 * they download later it is a correct document with the credential left out.
 */
export const integrationPdf = asyncHandler(async (req: Request, res: Response) => {
  const partyId = req.params['partyId'] as string;
  const party = await partyOr404(partyId);

  const key = await ApiKey.findOne({
    keyId: req.params['keyId'] as string,
    partyId: new Types.ObjectId(partyId),
  }).lean();
  if (!key) throw AppError.notFound('API key not found', ErrorCodes.NOT_FOUND);

  const supplied = (req.body as { secret?: string } | undefined)?.secret;

  const pkg = buildIntegrationPackage({
    partyName: party.companyName,
    partyCode: party.partyCode,
    keyId: key.keyId,
    secret: supplied ?? null,
    callbackUrl: key.callbackUrl ?? null,
    baseUrl: baseUrlOf(req),
  });

  const filename = `otdms-integration-${party.partyCode}-${key.keyId}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = renderIntegrationPdf(pkg);
  doc.pipe(res);
  doc.end();
});
