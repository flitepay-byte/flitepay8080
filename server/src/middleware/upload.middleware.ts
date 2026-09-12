import multer, { type FileFilterCallback } from 'multer';
import path from 'node:path';
import type { Request } from 'express';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';
import { ErrorCodes } from '../utils/errorCodes';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.pdf']);

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback): void {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
    cb(
      AppError.badRequest(
        ErrorCodes.UNSUPPORTED_FILE_TYPE,
        'Only JPEG, PNG, and PDF receipts are accepted',
        { received: file.mimetype },
      ),
    );
    return;
  }
  cb(null, true);
}

/**
 * Held in memory only long enough to verify and forward to Cloudinary.
 * Shared by proof receipts and payout-method screenshots — both are a single
 * JPEG/PNG/PDF attachment on an otherwise ordinary form submission.
 */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: env.PROOF_MAX_FILE_SIZE_MB * 1024 * 1024,
    files: 1,
    fields: 12,
  },
});

/** CSV uploads are held in memory: they are parsed immediately and discarded. */
export const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const okMime = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv'].includes(file.mimetype);
    if (ext !== '.csv' || !okMime) {
      cb(AppError.badRequest(ErrorCodes.UNSUPPORTED_FILE_TYPE, 'Only .csv files are accepted'));
      return;
    }
    cb(null, true);
  },
});

/** First bytes of each accepted format. */
const MAGIC: Record<string, number[][]> = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
};

/**
 * A browser-supplied Content-Type is attacker-controlled, so the uploaded
 * bytes are re-checked against its magic bytes before they are forwarded to
 * Cloudinary. A mismatch means the declared type was a lie.
 */
export function verifyFileSignature(buffer: Buffer, declaredMime: string): boolean {
  const signatures = MAGIC[declaredMime];
  if (!signatures) return false;
  return signatures.some((sig) => sig.every((byte, index) => buffer[index] === byte));
}
