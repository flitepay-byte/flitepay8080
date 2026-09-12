import { Schema, model, type Document, type Types } from 'mongoose';

export const API_KEY_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/**
 * A party's credentials for calling us from their own server.
 *
 * The party integrates our API into their site; their users never see us and
 * never sign in here. So the thing being authenticated is a *server*, not a
 * person, and the usual session cookie is the wrong tool: there is no browser,
 * no login, and nobody to re-authenticate when a token expires.
 *
 * The key id travels in the clear and identifies which party is calling. The
 * secret never travels at all — it signs the request and stays on both ends —
 * so an intercepted call cannot be replayed against a different body, and a
 * leaked log line cannot be turned into a working credential.
 *
 * The secret is stored encrypted rather than hashed, and that is forced by the
 * scheme rather than chosen: verifying an HMAC means recomputing it, which
 * needs the same key the caller used, so a one-way hash could never verify
 * anything. Encryption under a key held outside the database is what protects
 * it — a stolen dump is useless without the deployment's key. See
 * apiKey.service.ts, which explains why storing a hash and signing with *that*
 * would have been theatre.
 *
 * It is shown to the party exactly once, when the key is created. We never
 * display it again: a lost secret is replaced, not looked up.
 */
export interface IApiKey extends Document {
  _id: Types.ObjectId;
  partyId: Types.ObjectId;
  /** Travels in the clear on every request. Identifies the caller. */
  keyId: string;
  /** AES-256-GCM, as iv:tag:ciphertext. Never sent after creation. */
  secretEncrypted: string;
  /** What the party calls it, so they can revoke the right one. */
  label: string;
  status: ApiKeyStatus;
  /**
   * Where callbacks go for transactions this key creates, unless the call
   * names a different one. Stored per key rather than per party so a party can
   * point staging and production at different endpoints.
   */
  callbackUrl?: string | null;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  createdBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const apiKeySchema = new Schema<IApiKey>(
  {
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true, index: true },
    keyId: { type: String, required: true, unique: true, trim: true },
    secretEncrypted: { type: String, required: true },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    status: { type: String, enum: API_KEY_STATUSES, required: true, default: 'ACTIVE', index: true },
    callbackUrl: { type: String, default: null, maxlength: 500 },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

apiKeySchema.index({ partyId: 1, status: 1 });

/**
 * The secret must never leave the server, so it is stripped from every
 * serialisation by default rather than relying on each caller to remember.
 */
apiKeySchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete (ret as Partial<IApiKey>).secretEncrypted;
    return ret;
  },
});

export const ApiKey = model<IApiKey>('ApiKey', apiKeySchema);
