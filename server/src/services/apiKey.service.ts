/**
 * Issuing and checking the credentials a party's server calls us with.
 *
 * ---------------------------------------------------------------------------
 * WHY SIGNING RATHER THAN A BEARER TOKEN
 * ---------------------------------------------------------------------------
 *
 * A bearer token is a password: whoever holds it can do anything, and it is
 * sent in full on every request, so one leaked proxy log or one mis-scoped
 * error report hands over the party's money. A signature is not sent at all —
 * the secret stays on both ends and only the proof travels.
 *
 * The signature covers the timestamp, the method, the path *and* the exact
 * body bytes. That is what makes it worth doing: an attacker who captures a
 * ₹100 payout cannot change it to ₹100,000, because the signature would no
 * longer match, and cannot replay it tomorrow, because the timestamp is inside
 * the signed material and is checked against a narrow window.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SECRET IS ENCRYPTED AND NOT HASHED
 * ---------------------------------------------------------------------------
 *
 * A password can be stored as a one-way hash because verifying it only
 * requires hashing what the user typed and comparing. HMAC is not like that:
 * verifying a signature means *recomputing* it, which needs the same key the
 * caller used. There is no way to keep only a hash and still check a
 * signature — and storing the hash and signing with it instead would be pure
 * theatre, because then the stored value is the signing key and anyone who
 * reads the database can forge requests.
 *
 * So the secret is encrypted with AES-256-GCM under a key that lives in the
 * environment, never in the database. A stolen dump is useless on its own; an
 * attacker needs the dump and the deployment's key. GCM rather than CBC
 * because it authenticates as well as encrypts: a tampered ciphertext fails to
 * decrypt rather than silently producing a different secret.
 */
import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { Types } from 'mongoose';
import { ApiKey, type IApiKey } from '../models';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';
import { recordAudit } from './audit.service';
import { env } from '../config/env';
import type { Role } from '../types';

/** How far apart the two clocks may be before a request is refused. */
export const SIGNATURE_WINDOW_SECONDS = 300;

const ALGORITHM = 'aes-256-gcm';
/**
 * A fixed salt is fine here and a random one would be worse: this derives one
 * process-wide key from one configured value, so there is nothing per-record
 * to separate and a random salt would simply have to be stored beside it.
 */
const KEY_SALT = 'otdms:api-secret:v1';
let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  cachedKey ??= scryptSync(env.API_SECRET_ENCRYPTION_KEY, KEY_SALT, 32);
  return cachedKey;
}

/** iv:tag:ciphertext, all hex — one self-describing string, no side table. */
function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(':');
}

function decryptSecret(stored: string): string | null {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  if (!ivHex || !tagHex || !dataHex) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, or the ciphertext was tampered with. Either way this key
    // cannot be used, and saying which it was would help an attacker.
    return null;
  }
}

export interface IssuedKey {
  keyId: string;
  /** Shown exactly once. We can recover it, but we deliberately never do. */
  secret: string;
  record: IApiKey;
}

export async function issueApiKey(
  partyId: Types.ObjectId,
  label: string,
  actor: { userId: string; role: Role; ip?: string },
  callbackUrl?: string,
): Promise<IssuedKey> {
  const trimmed = label?.trim();
  if (!trimmed) {
    throw AppError.badRequest(ErrorCodes.VALIDATION_ERROR, 'Give the key a name so you can tell them apart');
  }

  const keyId = `otdms_${randomBytes(9).toString('hex')}`;
  const secret = randomBytes(32).toString('hex');

  const record = await ApiKey.create({
    partyId,
    keyId,
    secretEncrypted: encryptSecret(secret),
    label: trimmed,
    status: 'ACTIVE',
    callbackUrl: callbackUrl?.trim() || null,
    createdBy: new Types.ObjectId(actor.userId),
  });

  await recordAudit({
    action: 'API_KEY_ISSUED',
    targetCollection: 'ApiKey',
    targetId: record._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    // The secret is deliberately absent: an audit log is exactly the sort of
    // place a credential should never be written to.
    newState: { keyId, label: trimmed, status: 'ACTIVE' },
    metadata: { partyId: String(partyId) },
  });

  return { keyId, secret, record };
}

export async function revokeApiKey(
  keyId: string,
  partyId: Types.ObjectId,
  actor: { userId: string; role: Role; ip?: string },
): Promise<IApiKey> {
  // Scoped to the party in the filter itself, so one party cannot revoke
  // another's key by guessing its id.
  const revoked = await ApiKey.findOneAndUpdate(
    { keyId, partyId, status: 'ACTIVE' },
    { $set: { status: 'REVOKED', revokedAt: new Date() } },
    { new: true },
  );
  if (!revoked) throw AppError.notFound('API key not found', ErrorCodes.NOT_FOUND);

  await recordAudit({
    action: 'API_KEY_REVOKED',
    targetCollection: 'ApiKey',
    targetId: revoked._id,
    userId: actor.userId,
    role: actor.role,
    ip: actor.ip,
    newState: { keyId, status: 'REVOKED' },
  });

  return revoked;
}

export async function listApiKeys(partyId: Types.ObjectId): Promise<IApiKey[]> {
  return ApiKey.find({ partyId }).sort({ createdAt: -1 });
}

/**
 * The exact bytes a signature covers.
 *
 * Written as one function used by both sides — us when verifying, the party
 * when signing — because the commonest way an HMAC integration fails is the
 * two ends quietly disagreeing about what was signed. Newline separators are
 * explicit so no two different requests can produce the same string.
 */
export function signingPayload(timestamp: string, method: string, path: string, rawBody: string): string {
  return [timestamp, method.toUpperCase(), path, rawBody].join('\n');
}

export function computeSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time, so a wrong signature cannot be guessed a byte at a time. */
function signaturesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifiedCaller {
  key: IApiKey;
  partyId: Types.ObjectId;
}

/**
 * Check a signed request and say who is calling.
 *
 * Every failure returns the same unauthorised error on purpose. Telling an
 * attacker whether the key existed, whether the timestamp was stale, or
 * whether only the signature was wrong hands them a way to narrow the search;
 * a party integrating in good faith has the documentation and does not need to
 * be told which of the four things they got wrong.
 */
export async function verifySignedRequest(input: {
  keyId?: string;
  timestamp?: string;
  signature?: string;
  method: string;
  path: string;
  rawBody: string;
}): Promise<VerifiedCaller> {
  const unauthorised = (): AppError =>
    AppError.unauthorized('Invalid API credentials or signature', ErrorCodes.UNAUTHENTICATED);

  if (!input.keyId || !input.timestamp || !input.signature) throw unauthorised();

  const sentAt = Number(input.timestamp);
  if (!Number.isFinite(sentAt)) throw unauthorised();
  if (Math.abs(Date.now() / 1000 - sentAt) > SIGNATURE_WINDOW_SECONDS) throw unauthorised();

  const key = await ApiKey.findOne({ keyId: input.keyId, status: 'ACTIVE' });
  if (!key) throw unauthorised();

  const secret = decryptSecret(key.secretEncrypted);
  if (!secret) throw unauthorised();

  const expected = computeSignature(
    secret,
    signingPayload(input.timestamp, input.method, input.path, input.rawBody),
  );
  if (!signaturesMatch(expected, input.signature)) throw unauthorised();

  // Best-effort: a failed touch must never fail an otherwise valid request.
  void ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);

  return { key, partyId: key.partyId };
}

/**
 * The secret for a key, for signing an outbound callback.
 *
 * Only the callback sender should ever need this — it is how a party verifies
 * that a webhook really came from us. Returns null when the key cannot be
 * decrypted, which the caller must treat as "cannot sign", never as "send it
 * unsigned".
 */
export async function secretForSigning(keyId: string): Promise<string | null> {
  const key = await ApiKey.findOne({ keyId }).lean();
  if (!key) return null;
  return decryptSecret(key.secretEncrypted);
}
