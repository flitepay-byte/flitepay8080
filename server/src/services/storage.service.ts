import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { UploadApiResponse } from 'cloudinary';
import { getCloudinary, isCloudinaryConfigured } from '../config/cloudinary';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';

export interface UploadedFile {
  url: string;
  publicId: string;
}

/**
 * WHERE UPLOADED FILES GO
 * -----------------------
 *
 * Cloudinary when it is configured, local disk when it is not.
 *
 * The fallback exists because refusing the upload was the wrong failure. Proof
 * of payment is how a party and a captain settle an argument about real money;
 * a deployment without a Cloudinary account could still run every flow, but the
 * moment anybody attached a receipt they got "File storage is not configured",
 * which reads as a broken app rather than a missing optional credential. Losing
 * the evidence is worse than storing it somewhere less durable.
 *
 * Local disk is genuinely less durable and the difference is worth stating: the
 * files live in the container, so they do not survive it being replaced, and a
 * second instance cannot see the first one's uploads. That is fine for a
 * demonstration and for local work, and it is not fine for production — which
 * is why the warning below names the fix rather than merely noting the fact.
 */

const LOCAL_DIR = path.resolve(process.cwd(), 'uploads');
/** Served from here by the app; see app.ts. */
const LOCAL_ROUTE = '/uploads';

function resourceTypeFor(mimeType: string): 'image' | 'raw' {
  return mimeType === 'application/pdf' ? 'raw' : 'image';
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/png') return '.png';
  return '.jpg';
}

let warnedAboutLocalStorage = false;

function warnOnceAboutLocalStorage(): void {
  if (warnedAboutLocalStorage) return;
  warnedAboutLocalStorage = true;
  logger.warn(
    { directory: LOCAL_DIR },
    'Cloudinary is not configured — uploads are being written to local disk. ' +
      'These do not survive the container being replaced and are not shared between instances. ' +
      'Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET for durable storage.',
  );
}

/**
 * Store one uploaded file and return where to find it again.
 *
 * The public id is opaque and random rather than derived from the original
 * filename: a receipt named `aadhaar-front.jpg` should not become a guessable
 * URL, and two people uploading `receipt.jpg` must not collide.
 */
export async function uploadFile(buffer: Buffer, mimeType: string): Promise<UploadedFile> {
  if (!isCloudinaryConfigured()) return uploadToLocalDisk(buffer, mimeType);

  const cloudinary = getCloudinary();
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: env.CLOUDINARY_FOLDER,
        resource_type: resourceTypeFor(mimeType),
      },
      (err: Error | undefined, result: UploadApiResponse | undefined) => {
        if (err || !result) {
          logger.error({ err }, 'Cloudinary upload failed');
          reject(new AppError(502, ErrorCodes.FILE_UPLOAD_FAILED, 'Failed to upload file to storage'));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    Readable.from(buffer).pipe(uploadStream);
  });
}

async function uploadToLocalDisk(buffer: Buffer, mimeType: string): Promise<UploadedFile> {
  warnOnceAboutLocalStorage();

  // Random rather than content-addressed: two people uploading the same
  // screenshot must not be able to discover each other's by guessing.
  const name = `${Date.now().toString(36)}-${randomBytes(12).toString('hex')}${extensionFor(mimeType)}`;

  try {
    await mkdir(LOCAL_DIR, { recursive: true });
    await writeFile(path.join(LOCAL_DIR, name), buffer);
  } catch (err) {
    logger.error({ err, directory: LOCAL_DIR }, 'Could not write an upload to local disk');
    throw new AppError(502, ErrorCodes.FILE_UPLOAD_FAILED, 'Failed to store the uploaded file');
  }

  // `local:` marks where this came from, so a delete knows which store to talk
  // to without having to guess from the URL.
  return { url: `${LOCAL_ROUTE}/${name}`, publicId: `local:${name}` };
}

/** Best-effort cleanup when an upload succeeds but the surrounding request then fails. */
export async function deleteFile(publicId: string, mimeType?: string | null): Promise<void> {
  if (publicId.startsWith('local:')) {
    const name = publicId.slice('local:'.length);
    // Rejected rather than sanitised: a public id is ours, not a user's, so
    // anything with a path separator in it is a bug or an attack and neither
    // should be quietly worked around.
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      logger.warn({ publicId }, 'Refusing to delete a local upload with a suspicious name');
      return;
    }
    try {
      await unlink(path.join(LOCAL_DIR, name));
    } catch (err) {
      logger.warn({ err, publicId }, 'Failed to delete a local upload; it will remain orphaned');
    }
    return;
  }

  if (!isCloudinaryConfigured()) return;
  try {
    const cloudinary = getCloudinary();
    await cloudinary.uploader.destroy(publicId, {
      resource_type: mimeType ? resourceTypeFor(mimeType) : 'image',
    });
  } catch (err) {
    logger.warn({ err, publicId }, 'Failed to delete Cloudinary asset; it will remain orphaned');
  }
}

/** Where local uploads are written, so the app can serve them from the same place. */
export const LOCAL_UPLOAD_DIR = LOCAL_DIR;
export const LOCAL_UPLOAD_ROUTE = LOCAL_ROUTE;

/** Which store is in use, for the admin health view and for tests. */
export function storageBackend(): 'cloudinary' | 'local' {
  return isCloudinaryConfigured() ? 'cloudinary' : 'local';
}
